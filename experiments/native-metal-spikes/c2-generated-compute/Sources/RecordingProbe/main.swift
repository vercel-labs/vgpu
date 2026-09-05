import Darwin
import Foundation
import GeneratedFixture
import VGPUABI
import VGPUCompute
import VGPUCore
import VGPUResources
import _VGPUBackendSPI

struct ProbeError: Error, CustomStringConvertible {
  let description: String
}

enum AdvanceState: VGPUComputeProgram {
  struct Bindings: VGPUBindingSet {
    var source: VGPUStorage<UInt32>
    var mask: VGPUStorage<UInt32>
    var destination: VGPUStorage<UInt32>
    var audit: VGPUStorage<UInt32>

    func _vgpuEncodeBindings(to encoder: inout _VGPUBindingEncoder) throws {
      try encoder.runtimeSizedStorage(source, at: 0)
      try encoder.runtimeSizedStorage(mask, at: 1)
      try encoder.runtimeSizedStorage(destination, at: 2)
      try encoder.runtimeSizedStorage(audit, at: 3)
    }
  }

  static let _vgpuProgramDescriptor = _VGPUProgramDescriptor(
    artifactID: "recording-two-program-storage",
    programID: "AdvanceState",
    entryPointID: "advance",
    bindings: [
      _VGPULogicalBindingDescriptor(ordinal: 0, access: .read, runtimeSized: true),
      _VGPULogicalBindingDescriptor(ordinal: 1, access: .read, runtimeSized: true),
      _VGPULogicalBindingDescriptor(ordinal: 2, access: .readWrite, runtimeSized: true),
      _VGPULogicalBindingDescriptor(ordinal: 3, access: .readWrite, runtimeSized: true),
    ],
    workgroupSize: (2, 1, 1)
  )
}

enum MixState: VGPUComputeProgram {
  struct Bindings: VGPUBindingSet {
    var source: VGPUStorage<UInt32>
    var mask: VGPUStorage<UInt32>
    var destination: VGPUStorage<UInt32>
    var audit: VGPUStorage<UInt32>

    func _vgpuEncodeBindings(to encoder: inout _VGPUBindingEncoder) throws {
      try encoder.runtimeSizedStorage(source, at: 0)
      try encoder.runtimeSizedStorage(mask, at: 1)
      try encoder.runtimeSizedStorage(destination, at: 2)
      try encoder.runtimeSizedStorage(audit, at: 3)
    }
  }

  static let _vgpuProgramDescriptor = _VGPUProgramDescriptor(
    artifactID: "recording-two-program-storage",
    programID: "MixState",
    entryPointID: "mix",
    bindings: [
      _VGPULogicalBindingDescriptor(ordinal: 0, access: .read, runtimeSized: true),
      _VGPULogicalBindingDescriptor(ordinal: 1, access: .read, runtimeSized: true),
      _VGPULogicalBindingDescriptor(ordinal: 2, access: .readWrite, runtimeSized: true),
      _VGPULogicalBindingDescriptor(ordinal: 3, access: .readWrite, runtimeSized: true),
    ],
    workgroupSize: (1, 2, 1)
  )
}

func require(_ condition: @autoclosure () throws -> Bool, _ message: String) throws {
  if try !condition() { throw ProbeError(description: message) }
}

@MainActor
func waitUntil(_ description: String, condition: () -> Bool) async throws {
  for _ in 0..<10_000 {
    if condition() { return }
    await Task.yield()
  }
  throw ProbeError(description: "timed out waiting for \(description)")
}

actor RecordingExecutionGate {
  private var released = false
  private var waiters: [CheckedContinuation<Void, Never>] = []

  func wait() async {
    if released { return }
    await withCheckedContinuation { continuation in
      waiters.append(continuation)
    }
  }

  func releaseAll() {
    guard !released else { return }
    released = true
    let current = waiters
    waiters.removeAll(keepingCapacity: false)
    for waiter in current { waiter.resume() }
  }
}

actor AsyncSignal {
  private var signaled = false
  private var waiters: [CheckedContinuation<Void, Never>] = []

  func signal() {
    signaled = true
    let current = waiters
    waiters.removeAll(keepingCapacity: false)
    for waiter in current { waiter.resume() }
  }

  func wait() async {
    if signaled { return }
    await withCheckedContinuation { continuation in
      waiters.append(continuation)
    }
  }
}

final class SubmitBarrier: @unchecked Sendable {
  let entered = DispatchSemaphore(value: 0)
  let release = DispatchSemaphore(value: 0)
}

final class RecordingExecution: VGPUBackendExecution, @unchecked Sendable {
  private let backend: RecordingBackend
  private let command: VGPUBackendComputeCommand
  private let shouldFail: Bool

  init(
    backend: RecordingBackend,
    command: VGPUBackendComputeCommand,
    shouldFail: Bool
  ) {
    self.backend = backend
    self.command = command
    self.shouldFail = shouldFail
  }

  func wait() async throws {
    await backend.executionGate.wait()
    if shouldFail { throw RecordingBackendError.injectedExecutionFailure }
    try backend.emulate(command)
  }
}

enum RecordingBackendError: Error, Sendable {
  case invalidProgram
  case invalidCommand
  case missingAllocation
  case invalidRange
  case injectedAllocationFailure
  case injectedSubmitFailure
  case injectedExecutionFailure
}

final class RecordingBackend: VGPUResourceBackend, VGPUComputeBackend, @unchecked Sendable {
  private struct Allocation {
    var bytes: Data
    let access: VGPUStorageAccess
    let identity: UInt64
    let generation: UInt64
  }

  let contextIdentity: UInt64
  let executionGate = RecordingExecutionGate()
  private let lock = NSLock()
  private var nextHandle: UInt64 = 1
  private var nextProgramHandle: UInt64 = 1
  private var allocations: [VGPUBackendStorageHandle: Allocation] = [:]
  private var programs: [VGPUBackendProgramHandle: _VGPUProgramDescriptor] = [:]
  private var releasedIdentities: [UInt64] = []
  private var commands: [VGPUBackendComputeCommand] = []
  private var submitAttempts = 0
  private var prepareCount = 0
  private var shouldFailNextSubmit = false
  private var shouldFailNextExecution = false
  private var successfulAllocationsBeforeFailure: Int?
  private var nextSubmitBarrier: SubmitBarrier?

  init(contextIdentity: UInt64) { self.contextIdentity = contextIdentity }

  func allocateStorage(
    initialBytes: Data,
    access: VGPUStorageAccess
  ) throws -> VGPUBackendStorageHandle {
    lock.lock()
    defer { lock.unlock() }
    if let remaining = successfulAllocationsBeforeFailure {
      guard remaining > 0 else {
        successfulAllocationsBeforeFailure = nil
        throw RecordingBackendError.injectedAllocationFailure
      }
      successfulAllocationsBeforeFailure = remaining - 1
    }
    let handle = VGPUBackendStorageHandle(rawValue: nextHandle)
    nextHandle += 1
    allocations[handle] = Allocation(
      bytes: initialBytes,
      access: access,
      identity: handle.rawValue,
      generation: 1
    )
    return handle
  }

  func replaceStorageBytes(
    handle: VGPUBackendStorageHandle,
    range: Range<Int>,
    bytes: Data
  ) throws {
    lock.lock()
    defer { lock.unlock() }
    guard var allocation = allocations[handle] else {
      throw RecordingBackendError.missingAllocation
    }
    guard
      range.lowerBound >= 0,
      range.upperBound <= allocation.bytes.count,
      range.count == bytes.count
    else {
      throw RecordingBackendError.invalidRange
    }
    allocation.bytes.replaceSubrange(range, with: bytes)
    allocations[handle] = allocation
  }

  func readStorageBytes(
    handle: VGPUBackendStorageHandle,
    range: Range<Int>
  ) async throws -> Data {
    try read(handle: handle, range: range)
  }

  func storageSnapshot(
    handle: VGPUBackendStorageHandle
  ) throws -> VGPUBackendStorageSnapshot {
    lock.lock()
    defer { lock.unlock() }
    guard let allocation = allocations[handle] else {
      throw RecordingBackendError.missingAllocation
    }
    return VGPUBackendStorageSnapshot(
      handle: handle,
      contextIdentity: contextIdentity,
      allocationIdentity: allocation.identity,
      generation: allocation.generation,
      offset: 0,
      backingByteCount: allocation.bytes.count,
      access: allocation.access
    )
  }

  func releaseStorage(handle: VGPUBackendStorageHandle) {
    lock.lock()
    if let allocation = allocations.removeValue(forKey: handle) {
      releasedIdentities.append(allocation.identity)
    }
    lock.unlock()
  }

  func prepareCompute(
    _ program: _VGPUProgramDescriptor
  ) throws -> VGPUBackendProgramHandle {
    guard isKnownProgram(program) else {
      throw RecordingBackendError.invalidProgram
    }
    lock.lock()
    prepareCount += 1
    let handle = VGPUBackendProgramHandle(rawValue: nextProgramHandle)
    nextProgramHandle += 1
    programs[handle] = program
    lock.unlock()
    return handle
  }

  func submitCompute(
    _ command: VGPUBackendComputeCommand
  ) throws -> any VGPUBackendExecution {
    lock.lock()
    submitAttempts += 1
    let preparedProgram = programs[command.programHandle]
    lock.unlock()
    guard preparedProgram == command.program else {
      throw RecordingBackendError.invalidProgram
    }
    guard command.bindings.map(\.ordinal) == command.program.bindings.map(\.ordinal) else {
      throw RecordingBackendError.invalidCommand
    }
    lock.lock()
    let submitBarrier = nextSubmitBarrier
    nextSubmitBarrier = nil
    lock.unlock()
    if let submitBarrier {
      submitBarrier.entered.signal()
      submitBarrier.release.wait()
    }
    lock.lock()
    if shouldFailNextSubmit {
      shouldFailNextSubmit = false
      lock.unlock()
      throw RecordingBackendError.injectedSubmitFailure
    }
    let shouldFail = shouldFailNextExecution
    shouldFailNextExecution = false
    commands.append(command)
    lock.unlock()
    return RecordingExecution(backend: self, command: command, shouldFail: shouldFail)
  }

  func emulate(_ command: VGPUBackendComputeCommand) throws {
    guard command.program.programID == "AssemblyRuntimeSizedStorage" else { return }
    let input = command.bindings[0]
    let output = command.bindings[1]
    let count = (input.boundByteCount - 4) / 12
    guard count > 0, input.elementCount == count else {
      throw RecordingBackendError.invalidCommand
    }
    let idOffset = 4 + (count - 1) * 12 + 8
    let id = try UInt32._vgpuUnpack(
      read(
        handle: input.snapshot.handle,
        range: idOffset..<(idOffset + 4)
      )
    )
    try replaceStorageBytes(
      handle: output.snapshot.handle,
      range: 0..<8,
      bytes: UInt32._vgpuPack(UInt32(count)) + UInt32._vgpuPack(id)
    )
  }

  var submittedRanges: [Int] {
    lock.lock()
    defer { lock.unlock() }
    return commands.map { $0.bindings[0].boundByteCount }
  }

  var submittedInputSnapshots: [(identity: UInt64, generation: UInt64)] {
    lock.lock()
    defer { lock.unlock() }
    return commands.map {
      ($0.bindings[0].snapshot.allocationIdentity, $0.bindings[0].snapshot.generation)
    }
  }

  var pipelinePrepareCount: Int {
    lock.lock()
    defer { lock.unlock() }
    return prepareCount
  }

  var submittedCommands: [VGPUBackendComputeCommand] {
    lock.lock()
    defer { lock.unlock() }
    return commands
  }

  var submitAttemptCount: Int {
    lock.lock()
    defer { lock.unlock() }
    return submitAttempts
  }

  var liveAllocationIdentities: [UInt64] {
    lock.lock()
    defer { lock.unlock() }
    return allocations.values.map(\.identity).sorted()
  }

  func contains(allocationIdentity: UInt64) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    return allocations.values.contains { $0.identity == allocationIdentity }
  }

  func releaseCount(allocationIdentity: UInt64) -> Int {
    lock.lock()
    defer { lock.unlock() }
    return releasedIdentities.filter { $0 == allocationIdentity }.count
  }

  func failNextSubmit() {
    lock.lock()
    shouldFailNextSubmit = true
    lock.unlock()
  }

  func failAllocation(afterSuccessfulAllocations count: Int) {
    lock.lock()
    successfulAllocationsBeforeFailure = count
    lock.unlock()
  }

  func failNextExecution() {
    lock.lock()
    shouldFailNextExecution = true
    lock.unlock()
  }

  func blockNextSubmit(with barrier: SubmitBarrier) {
    lock.lock()
    nextSubmitBarrier = barrier
    lock.unlock()
  }

  private func read(
    handle: VGPUBackendStorageHandle,
    range: Range<Int>
  ) throws -> Data {
    lock.lock()
    defer { lock.unlock() }
    guard let allocation = allocations[handle] else {
      throw RecordingBackendError.missingAllocation
    }
    guard range.lowerBound >= 0, range.upperBound <= allocation.bytes.count else {
      throw RecordingBackendError.invalidRange
    }
    return allocation.bytes.subdata(in: range)
  }

  private func isKnownProgram(_ program: _VGPUProgramDescriptor) -> Bool {
    program == InspectValues._vgpuProgramDescriptor
      || program == AdvanceState._vgpuProgramDescriptor
      || program == MixState._vgpuProgramDescriptor
  }
}

final class ErrorRecorder: @unchecked Sendable {
  private let lock = NSLock()
  private var errors: [VGPUError] = []

  func record(_ error: VGPUError) {
    lock.lock()
    errors.append(error)
    lock.unlock()
  }

  var count: Int {
    lock.lock()
    defer { lock.unlock() }
    return errors.count
  }
}

func expectFailure(_ operation: () throws -> Void, _ message: String) throws {
  do {
    try operation()
    throw ProbeError(description: message)
  } catch is ProbeError {
    throw ProbeError(description: message)
  } catch {}
}

func expectVGPUFailure(
  code: VGPUErrorCode,
  _ operation: () throws -> Void,
  _ message: String
) throws {
  do {
    try operation()
    throw ProbeError(description: message)
  } catch let error as VGPUError {
    try require(error.code == code, "\(message): received \(error.code.rawValue)")
  } catch {
    throw ProbeError(description: "\(message): received \(error)")
  }
}

func emit(_ report: [String: Any]) throws {
  let data = try JSONSerialization.data(
    withJSONObject: report,
    options: [.sortedKeys, .withoutEscapingSlashes]
  )
  guard let json = String(data: data, encoding: .utf8) else {
    throw ProbeError(description: "could not encode JSON")
  }
  print(json)
}

@MainActor
func verifyComputeStorageContracts() async throws {
  let rollbackBackend = RecordingBackend(contextIdentity: 400)
  let rollbackGPU = VGPU(backend: rollbackBackend)
  rollbackBackend.failAllocation(afterSuccessfulAllocations: 1)
  try expectFailure(
    {
      _ = try rollbackGPU.pingPongStorage(
        UInt32.self,
        count: 2,
        initialValues: [7, 9]
      )
    },
    "a ping-pong pair survived its second allocation failure"
  )
  try require(
    rollbackBackend.liveAllocationIdentities.isEmpty,
    "a failed ping-pong allocation leaked its read generation"
  )
  try require(
    rollbackBackend.releaseCount(allocationIdentity: 1) == 1,
    "a failed ping-pong allocation did not close its read generation exactly once"
  )
  try rollbackGPU.dispose()

  let backend = RecordingBackend(contextIdentity: 500)
  let gpu = VGPU(backend: backend)
  let initial: [UInt32] = [1, 3, 5, 7, 9, 11, 13, 15]
  let state = try gpu.pingPongStorage(
    UInt32.self,
    count: initial.count,
    initialValues: initial
  )
  let originalRead = state.read
  let originalWrite = state.write
  let readInitialValues = try await originalRead.read()
  let writeInitialValues = try await originalWrite.read()
  try require(readInitialValues == initial, "ping-pong read initialization drifted")
  try require(
    writeInitialValues == [UInt32](repeating: 0, count: initial.count),
    "ping-pong write storage was not zero initialized"
  )

  let advanceAudit = try gpu.storage(UInt32.self, count: 4)
  let mixAudit = try gpu.storage(UInt32.self, count: 4)
  let advance = try gpu.compute(
    AdvanceState.self,
    bindings: .init(
      source: state.read,
      mask: state.read,
      destination: state.write,
      audit: advanceAudit
    )
  )
  let errors = ErrorRecorder()
  let unsubscribe = gpu.onError { error in errors.record(error) }
  let first = try advance.dispatch(x: 2, y: 1, z: 2)

  state.swap()
  try require(
    state.read === originalWrite && state.write === originalRead,
    "ping-pong swap did not reverse its resource roles"
  )
  try advance.set(\.source, to: state.read)
  let transientPending = gpu._pendingWorkCount
  let transientSubmits = backend.submitAttemptCount
  try expectVGPUFailure(
    code: .storageAliasing,
    { _ = try advance.dispatch(x: 2, y: 1, z: 2) },
    "a transient writable alias reached dispatch"
  )
  try require(
    gpu._pendingWorkCount == transientPending,
    "a transient alias registered work"
  )
  try require(
    backend.submitAttemptCount == transientSubmits && errors.count == 0,
    "a transient alias reached the backend or onError"
  )
  try advance.set(\.mask, to: state.read)
  try advance.set(\.destination, to: state.write)

  let mix = try gpu.compute(
    MixState.self,
    bindings: .init(
      source: state.read,
      mask: state.read,
      destination: state.write,
      audit: mixAudit
    )
  )
  let second = try mix.dispatch(x: 2, y: 2, z: 1)
  let commands = backend.submittedCommands
  try require(commands.count == 2, "compute-storage submissions drifted")
  let advanceCommand = commands[0]
  let mixCommand = commands[1]
  try require(
    advanceCommand.program.artifactID == mixCommand.program.artifactID
      && advanceCommand.program.programID != mixCommand.program.programID,
    "two programs in one artifact lost independent program identity"
  )
  try require(
    advanceCommand.bindings.map(\.ordinal) == [0, 1, 2, 3]
      && mixCommand.bindings.map(\.ordinal) == [0, 1, 2, 3],
    "program-local binding ordinals drifted"
  )
  try require(
    advanceCommand.bindings.map(\.elementCount) == [8, 8, 8, 4]
      && mixCommand.bindings.map(\.elementCount) == [8, 8, 8, 4],
    "root runtime-sized storage lost its element count"
  )
  try require(
    advanceCommand.threadgroups.x == 2 && advanceCommand.threadgroups.y == 1
      && advanceCommand.threadgroups.z == 2 && mixCommand.threadgroups.x == 2
      && mixCommand.threadgroups.y == 2 && mixCommand.threadgroups.z == 1,
    "three-dimensional dispatch snapshots drifted"
  )
  let firstIdentities = advanceCommand.bindings.map {
    ($0.snapshot.allocationIdentity, $0.snapshot.generation)
  }
  let secondIdentities = mixCommand.bindings.map {
    ($0.snapshot.allocationIdentity, $0.snapshot.generation)
  }
  try require(
    firstIdentities[0] == firstIdentities[1]
      && firstIdentities[0] != firstIdentities[2]
      && secondIdentities[0] == secondIdentities[1]
      && secondIdentities[0] == firstIdentities[2]
      && secondIdentities[2] == firstIdentities[0],
    "dispatch snapshots did not preserve read/read aliases across a role swap"
  )

  await backend.executionGate.releaseAll()
  await first.settled()
  await second.settled()

  let beforeAlias = Set(backend.liveAllocationIdentities)
  let aliased = try gpu.storage(UInt32.self, count: 8)
  let aliasedIdentity = try requireOnly(
    Array(Set(backend.liveAllocationIdentities).subtracting(beforeAlias))
  )
  let aliasAudit = try gpu.storage(UInt32.self, count: 4)
  let aliasCompute = try gpu.compute(
    AdvanceState.self,
    bindings: .init(
      source: aliased,
      mask: aliased,
      destination: aliased,
      audit: aliasAudit
    )
  )
  let aliasPending = gpu._pendingWorkCount
  let aliasSubmits = backend.submitAttemptCount
  try expectVGPUFailure(
    code: .storageAliasing,
    { _ = try aliasCompute.dispatch(x: 2, y: 1, z: 2) },
    "a writable full-generation alias succeeded"
  )
  try require(
    gpu._pendingWorkCount == aliasPending && backend.submitAttemptCount == aliasSubmits
      && errors.count == 0,
    "an alias failure escaped preflight"
  )
  try aliased.dispose()
  try require(
    backend.releaseCount(allocationIdentity: aliasedIdentity) == 1,
    "an alias failure retained a prepared lease"
  )
  try aliasAudit.dispose()
  unsubscribe()

  try originalRead.dispose()
  try originalWrite.dispose()
  try advanceAudit.dispose()
  try mixAudit.dispose()
  try gpu.dispose()
}

@MainActor
func run() async throws {
  try expectFailure(
    {
      _ = try _VGPURuntimeArrayLayoutDescriptor(
        tailOffset: 4,
        elementStride: 12,
        minimumBindingSize: 8
      ).rangeBytes(exactElementCount: 1)
    },
    "a runtime-array descriptor whose minimum omits its first element succeeded"
  )
  let backend = RecordingBackend(contextIdentity: 100)
  let gpu = VGPU(backend: backend)
  let transfer = UnsafeTransfer(value: gpu)
  let accessStarted = AsyncSignal()
  let releaseAccess = DispatchSemaphore(value: 0)
  let accessTask = Task.detached { () -> Bool in
    do {
      try transfer.value.withOpenAccess { () -> Void in
        Task { await accessStarted.signal() }
        releaseAccess.wait()
      }
      return true
    } catch {
      return false
    }
  }
  await accessStarted.wait()
  do {
    try gpu.withOpenAccess {}
    throw ProbeError(description: "concurrent graph access did not fail immediately")
  } catch let error as VGPUError {
    try require(error.code == .concurrentAccess, "concurrent access returned the wrong error")
  }
  releaseAccess.signal()
  let originalAccessSucceeded = await accessTask.value
  try require(originalAccessSucceeded, "the original access owner failed")
  try gpu.withOpenAccess {
    try gpu.withOpenAccess {}
  }
  let initial = [
    Particle(mass: 10, id: 101),
    Particle(mass: 20, id: 202),
    Particle(mass: 30, id: 303),
    Particle(mass: 40, id: 404),
  ]
  let values: Values.Storage = try gpu.storage(
    Values.self,
    prefix: .init(prefix: 77),
    capacity: 4,
    access: .read,
    initialElements: initial
  )
  let short = try values.binding(elementCount: 2)
  let long = try values.binding(elementCount: 4)
  let output1 = try gpu.storage(UInt32.self, count: 2)
  let output2 = try gpu.storage(UInt32.self, count: 2)
  let compute = try gpu.compute(
    InspectValues.self,
    bindings: .init(values: short, output: output1)
  )
  try require(backend.pipelinePrepareCount == 1, "gpu.compute did not prepare exactly once")
  let readOnlyOutput = try gpu.storage(UInt32.self, count: 2, access: .read)
  try expectFailure(
    {
      _ = try gpu.compute(
        InspectValues.self,
        bindings: .init(values: long, output: readOnlyOutput)
      )
    },
    "an access-incompatible output succeeded"
  )

  let submitBarrier = SubmitBarrier()
  backend.blockNextSubmit(with: submitBarrier)
  let computeTransfer = UnsafeTransfer(value: compute)
  let firstDispatch = Task.detached {
    try computeTransfer.value.dispatch(x: 1)
  }
  try require(
    submitBarrier.entered.wait(timeout: .now() + 2) == .success,
    "compute submit did not reach its barrier"
  )
  try require(gpu._pendingWorkCount == 1, "dispatch reached submit before registering its ticket")
  let racingSnapshotsBefore = gpu._settledSnapshotCount
  let racingSettlement = Task { @MainActor in await gpu.settled() }
  try await waitUntil("racing context settled snapshot") {
    gpu._settledSnapshotCount == racingSnapshotsBefore + 1
  }
  submitBarrier.release.signal()
  let first = try await firstDispatch.value
  try compute.set(\.values, to: long)
  try compute.set(\.output, to: output2)

  let foreignBackend = RecordingBackend(contextIdentity: 200)
  let foreignGPU = VGPU(backend: foreignBackend)
  let foreignOutput = try foreignGPU.storage(UInt32.self, count: 2)
  try expectFailure(
    { try compute.set(\.output, to: foreignOutput) },
    "a context-mismatched set succeeded"
  )
  let doomed: Values.Storage = try gpu.storage(
    Values.self,
    prefix: .init(prefix: 0),
    capacity: 1,
    access: .read,
    initialElements: [initial[0]]
  )
  let doomedBinding = try doomed.binding(elementCount: 1)
  try doomed.dispose()
  try expectFailure(
    { try compute.set(\.values, to: doomedBinding) },
    "a disposed set succeeded"
  )
  try expectFailure(
    { _ = try compute.dispatch(x: 0) },
    "an invalid dispatch succeeded"
  )

  let second = try compute.dispatch(x: 1)
  try require(backend.submittedRanges == [28, 52], "dispatch snapshots were not independent")
  let inputSnapshots = backend.submittedInputSnapshots
  try require(
    inputSnapshots.count == 2 && inputSnapshots[0] == inputSnapshots[1],
    "runtime views did not retain one allocation generation"
  )
  let inputIdentity = inputSnapshots[0].identity
  try values.dispose()
  try require(
    backend.contains(allocationIdentity: inputIdentity),
    "an in-flight generation was released at dispose"
  )

  let snapshotsBeforeSettlement = gpu._settledSnapshotCount
  let gpuSettlement = Task { @MainActor in await gpu.settled() }
  try await waitUntil("context settled snapshot") {
    gpu._settledSnapshotCount == snapshotsBeforeSettlement + 1
  }
  await backend.executionGate.releaseAll()
  await first.settled()
  await second.settled()
  await racingSettlement.value
  await gpuSettlement.value
  try require(
    backend.releaseCount(allocationIdentity: inputIdentity) == 1,
    "the disposed generation was not released once after completion"
  )
  let readbacks = [try await output1.read(), try await output2.read()]
  try require(readbacks == [[2, 202], [4, 404]], "recording readback drifted")

  let errorValues: Values.Storage = try gpu.storage(
    Values.self,
    prefix: .init(prefix: 1),
    capacity: 1,
    access: .read,
    initialElements: [initial[0]]
  )
  let errorOutput = try gpu.storage(UInt32.self, count: 2)
  let errorCompute = try gpu.compute(
    InspectValues.self,
    bindings: .init(values: try errorValues.binding(elementCount: 1), output: errorOutput)
  )
  let errors = ErrorRecorder()
  let unsubscribe = gpu.onError { error in errors.record(error) }
  backend.failNextSubmit()
  let pendingBeforeSubmitFailure = gpu._pendingWorkCount
  try expectFailure(
    { _ = try errorCompute.dispatch(x: 1) },
    "an injected synchronous submit failure succeeded"
  )
  try require(
    gpu._pendingWorkCount == pendingBeforeSubmitFailure && errors.count == 0,
    "a synchronous submit failure leaked work or reached onError"
  )
  backend.failNextExecution()
  let failedSubmission = try errorCompute.dispatch(x: 1)
  await failedSubmission.settled()
  try require(errors.count == 1, "a deferred backend failure did not reach onError once")
  unsubscribe()
  backend.failNextExecution()
  let unobservedSubmission = try errorCompute.dispatch(x: 1)
  await unobservedSubmission.settled()
  let unobservedDiagnostics = gpu._observerEvents.filter { event in
    if case .unobserved(_, code: .backendOperationFailed) = event { return true }
    return false
  }
  try require(
    unobservedDiagnostics.count == 1 && errors.count == 1,
    "an unobserved deferred failure did not emit exactly one diagnostic"
  )
  let lateErrors = ErrorRecorder()
  let unsubscribeLate = gpu.onError { error in lateErrors.record(error) }
  try require(lateErrors.count == 0, "a late observer received an error backlog")
  unsubscribeLate()

  try output1.dispose()
  try output2.dispose()
  try readOnlyOutput.dispose()
  try errorValues.dispose()
  try errorOutput.dispose()
  try foreignOutput.dispose()
  try foreignGPU.dispose()
  try gpu.dispose()

  let closeBackend = RecordingBackend(contextIdentity: 300)
  let closeGPU = VGPU(backend: closeBackend)
  let closeStorage = try closeGPU.storage(UInt32.self, count: 1)
  let closeIdentity = try requireOnly(closeBackend.liveAllocationIdentities)
  try closeGPU.dispose()
  try require(
    closeBackend.releaseCount(allocationIdentity: closeIdentity) == 1,
    "context close did not close its child generation"
  )
  try expectFailure(
    { _ = try closeStorage.readForSynchronousGate() },
    "a child resource remained usable after context close"
  )
  try await verifyComputeStorageContracts()
  try emit([
    "accessGateFailFast": true,
    "accessGateStackReentrancy": true,
    "atomicSetRollback": true,
    "deferredErrorDelivery": true,
    "computeStorageAliasing": true,
    "computeStorageProgramIdentity": true,
    "effectiveRanges": [28, 52],
    "gate": "c2-generated-compute-recording",
    "generationReleaseAfterCompletion": true,
    "pingPongStorage": true,
    "contextClosesChildren": true,
    "synchronousSubmitRollback": true,
    "pipelinePrepareCount": backend.pipelinePrepareCount,
    "readbacks": readbacks,
    "runtimeLayoutValidation": true,
    "sameBackingGeneration": true,
    "schemaVersion": 1,
    "settledRegistrationLinearization": true,
    "status": "passed",
    "unobservedDiagnostic": true,
  ])
}

struct UnsafeTransfer<Value>: @unchecked Sendable {
  let value: Value
}

func requireOnly(_ values: [UInt64]) throws -> UInt64 {
  guard values.count == 1, let value = values.first else {
    throw ProbeError(description: "expected exactly one live allocation")
  }
  return value
}

extension VGPUStorage {
  fileprivate func readForSynchronousGate() throws -> Bool {
    try _box.validate(
      boundByteCount: sizeInBytes,
      requiredAccess: access,
      contextIdentity: nil
    )
    return true
  }
}

@main
enum RecordingProbe {
  static func main() async {
    do {
      try await run()
    } catch {
      FileHandle.standardError.write(Data("\(error)\n".utf8))
      Darwin.exit(1)
    }
  }
}
