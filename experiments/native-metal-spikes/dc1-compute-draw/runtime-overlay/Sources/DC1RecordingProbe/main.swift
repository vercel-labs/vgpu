import DC1GeneratedFixture
import Darwin
import Foundation
import VGPUABI
import VGPUCompute
import VGPUCore
import VGPURender
import VGPUResources
import _VGPUBackendSPI

struct ProbeError: Error, CustomStringConvertible {
  let description: String
}

func require(_ condition: @autoclosure () -> Bool, _ message: String) throws {
  if !condition() { throw ProbeError(description: message) }
}

actor ExecutionGate {
  private var released = false
  private var waiters: [CheckedContinuation<Void, Never>] = []

  func wait() async {
    if released { return }
    await withCheckedContinuation { continuation in
      waiters.append(continuation)
    }
  }

  func releaseAll() {
    released = true
    let current = waiters
    waiters.removeAll(keepingCapacity: false)
    for waiter in current { waiter.resume() }
  }
}

final class GateExecution: VGPUBackendExecution, @unchecked Sendable {
  private let gate: ExecutionGate

  init(gate: ExecutionGate) { self.gate = gate }

  func wait() async throws {
    await gate.wait()
  }
}

enum BackendError: Error, Sendable {
  case invalidProgram
  case invalidCommand
  case missingAllocation
  case invalidRange
}

final class RecordingBackend: VGPUResourceBackend, VGPUComputeBackend, VGPURenderBackend,
  @unchecked Sendable
{
  private struct Allocation {
    var bytes: Data
    let identity: UInt64
    let generation: UInt64
    let access: VGPUStorageAccess
    let usage: VGPUBufferUsage
  }

  let contextIdentity: UInt64
  let gate = ExecutionGate()
  private let lock = NSLock()
  private var nextStorage: UInt64 = 1
  private var allocations: [VGPUBackendStorageHandle: Allocation] = [:]
  private var traceValue: [String] = []
  private var computeSnapshotValue: VGPUBackendStorageSnapshot?
  private var drawSnapshotValue: VGPUBackendStorageSnapshot?
  private var drawViewRangeValue: Range<Int>?
  private var consumerByteOffsetValue: Int?
  private var physicalByteOffsetValue: Int?
  private var renderedArgumentsValue: [UInt32] = []
  private var renderedGreenValue = false
  private var directVertexCountValue: Int?
  private var frameSubmissionsValue = 0
  private var storageReadsValue = 0

  init(contextIdentity: UInt64) {
    self.contextIdentity = contextIdentity
  }

  func allocateStorage(
    initialBytes: Data,
    access: VGPUStorageAccess,
    usage: VGPUBufferUsage
  ) throws -> VGPUBackendStorageHandle {
    lock.lock()
    defer { lock.unlock() }
    let handle = VGPUBackendStorageHandle(rawValue: nextStorage)
    nextStorage += 1
    allocations[handle] = Allocation(
      bytes: initialBytes,
      identity: handle.rawValue,
      generation: 1,
      access: access,
      usage: usage
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
    guard var allocation = allocations[handle], range.count == bytes.count,
      range.lowerBound >= 0, range.upperBound <= allocation.bytes.count
    else {
      throw BackendError.invalidRange
    }
    allocation.bytes.replaceSubrange(range, with: bytes)
    allocations[handle] = allocation
  }

  func readStorageBytes(
    handle: VGPUBackendStorageHandle,
    range: Range<Int>
  ) async throws -> Data {
    try readStorageBytesSynchronously(handle: handle, range: range)
  }

  private func readStorageBytesSynchronously(
    handle: VGPUBackendStorageHandle,
    range: Range<Int>
  ) throws -> Data {
    lock.lock()
    storageReadsValue += 1
    defer { lock.unlock() }
    guard let allocation = allocations[handle], range.lowerBound >= 0,
      range.upperBound <= allocation.bytes.count
    else {
      throw BackendError.invalidRange
    }
    return allocation.bytes.subdata(in: range)
  }

  func storageSnapshot(
    handle: VGPUBackendStorageHandle
  ) throws -> VGPUBackendStorageSnapshot {
    lock.lock()
    defer { lock.unlock() }
    guard let allocation = allocations[handle] else { throw BackendError.missingAllocation }
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
    allocations.removeValue(forKey: handle)
    lock.unlock()
  }

  func prepareCompute(
    _ program: _VGPUProgramDescriptor
  ) throws -> VGPUBackendProgramHandle {
    guard program == ProducePacket._vgpuProgramDescriptor else {
      throw BackendError.invalidProgram
    }
    return VGPUBackendProgramHandle(rawValue: 1)
  }

  func submitCompute(
    _ command: VGPUBackendComputeCommand
  ) throws -> any VGPUBackendExecution {
    guard command.programHandle == VGPUBackendProgramHandle(rawValue: 1),
      command.bindings.count == 1,
      command.bindings[0].ordinal == 0,
      command.bindings[0].boundByteCount == 32,
      command.bindings[0].elementCount == nil,
      command.threadgroups.x == 1,
      command.threadgroups.y == 1,
      command.threadgroups.z == 1
    else {
      throw BackendError.invalidCommand
    }
    let binding = command.bindings[0]
    lock.lock()
    guard var allocation = allocations[binding.snapshot.handle] else {
      lock.unlock()
      throw BackendError.missingAllocation
    }
    guard allocation.usage.contains(.indirect) else {
      lock.unlock()
      throw BackendError.invalidCommand
    }
    allocation.bytes.replaceSubrange(
      16..<32,
      with: packed([3, 1, 0, 0])
    )
    allocations[binding.snapshot.handle] = allocation
    computeSnapshotValue = binding.snapshot
    traceValue.append("computeCommit")
    lock.unlock()
    return GateExecution(gate: gate)
  }

  func createOffscreenTarget(width: Int, height: Int) throws -> VGPUBackendTargetHandle {
    guard width == 4, height == 4 else { throw BackendError.invalidCommand }
    return VGPUBackendTargetHandle(rawValue: 1)
  }

  func prepareDraw(
    _ descriptor: _VGPUDrawProgramDescriptor
  ) throws -> VGPUBackendDrawProgramHandle {
    guard descriptor == ConsumePacket._vgpuDrawProgramDescriptor else {
      throw BackendError.invalidProgram
    }
    return VGPUBackendDrawProgramHandle(rawValue: 1)
  }

  func submitFrame(
    _ commands: [VGPUBackendFrameCommand]
  ) throws -> any VGPUBackendExecution {
    guard commands.count == 1, commands[0].target == VGPUBackendTargetHandle(rawValue: 1),
      commands[0].draws.count == 1
    else {
      throw BackendError.invalidCommand
    }
    let draw = commands[0].draws[0]
    guard draw.program == VGPUBackendDrawProgramHandle(rawValue: 1) else {
      throw BackendError.invalidProgram
    }
    lock.lock()
    guard let allocation = allocations[draw.snapshot.handle] else {
      lock.unlock()
      throw BackendError.missingAllocation
    }
    let start = draw.physicalByteOffset
    let end = start + 16
    guard start >= 0, end <= allocation.bytes.count else {
      lock.unlock()
      throw BackendError.invalidRange
    }
    let arguments = unpack(allocation.bytes.subdata(in: start..<end))
    drawSnapshotValue = draw.snapshot
    drawViewRangeValue = draw.viewRange
    consumerByteOffsetValue = draw.consumerByteOffset
    physicalByteOffsetValue = draw.physicalByteOffset
    directVertexCountValue = draw.directVertexCount
    renderedArgumentsValue = arguments
    renderedGreenValue = arguments == [3, 1, 0, 0]
    frameSubmissionsValue += 1
    traceValue.append("frameCommit")
    lock.unlock()
    return GateExecution(gate: gate)
  }

  var trace: [String] {
    lock.lock()
    defer { lock.unlock() }
    return traceValue
  }

  var frameSubmissions: Int {
    lock.lock()
    defer { lock.unlock() }
    return frameSubmissionsValue
  }

  var storageReads: Int {
    lock.lock()
    defer { lock.unlock() }
    return storageReadsValue
  }

  var evidence: Evidence {
    lock.lock()
    defer { lock.unlock() }
    return Evidence(
      computeIdentity: computeSnapshotValue?.allocationIdentity,
      computeGeneration: computeSnapshotValue?.generation,
      drawIdentity: drawSnapshotValue?.allocationIdentity,
      drawGeneration: drawSnapshotValue?.generation,
      viewRange: drawViewRangeValue,
      consumerByteOffset: consumerByteOffsetValue,
      physicalByteOffset: physicalByteOffsetValue,
      renderedArguments: renderedArgumentsValue,
      renderedGreen: renderedGreenValue,
      directVertexCount: directVertexCountValue
    )
  }
}

struct Evidence {
  let computeIdentity: UInt64?
  let computeGeneration: UInt64?
  let drawIdentity: UInt64?
  let drawGeneration: UInt64?
  let viewRange: Range<Int>?
  let consumerByteOffset: Int?
  let physicalByteOffset: Int?
  let renderedArguments: [UInt32]
  let renderedGreen: Bool
  let directVertexCount: Int?
}

final class ProbeLease: _VGPUResourceLease, @unchecked Sendable {
  private let lock = NSLock()
  private var released = false

  func release() {
    lock.lock()
    released = true
    lock.unlock()
  }
}

final class OverflowStorageBox: _VGPUStorageBox, @unchecked Sendable {
  let contextIdentity: UInt64

  init(contextIdentity: UInt64) { self.contextIdentity = contextIdentity }

  var isDisposed: Bool { false }

  func replaceBytes(in _: Range<Int>, with _: Data) throws {
    throw BackendError.invalidCommand
  }

  func readBytes(in _: Range<Int>) async throws -> Data {
    throw BackendError.invalidCommand
  }

  func validate(
    boundByteCount _: Int,
    requiredAccess _: VGPUStorageAccess,
    contextIdentity _: UInt64?
  ) throws {}

  func prepare(
    boundByteCount: Int,
    elementCount _: Int?,
    requiredAccess _: VGPUStorageAccess
  ) throws -> _VGPUPreparedStorage {
    _VGPUPreparedStorage(
      snapshot: _VGPUStorageSnapshot(
        handle: UInt64.max,
        contextIdentity: contextIdentity,
        allocationIdentity: UInt64.max,
        generation: 1,
        offset: Int.max - 8,
        backingByteCount: Int.max,
        access: .read
      ),
      boundByteCount: boundByteCount,
      elementCount: nil,
      lease: ProbeLease()
    )
  }

  func dispose() throws {}
}

final class ErrorRecorder: @unchecked Sendable {
  private let lock = NSLock()
  private var value = 0

  func record(_: VGPUError) {
    lock.lock()
    value += 1
    lock.unlock()
  }

  var count: Int {
    lock.lock()
    defer { lock.unlock() }
    return value
  }
}

func packed(_ values: [UInt32]) -> Data {
  values.reduce(into: Data()) { bytes, value in
    bytes.append(UInt32._vgpuPack(value))
  }
}

func unpack(_ bytes: Data) -> [UInt32] {
  stride(from: 0, to: bytes.count, by: 4).map { offset in
    try! UInt32._vgpuUnpack(bytes.subdata(in: offset..<(offset + 4)))
  }
}

struct FailureEvidence {
  let code: String
  let submissionDelta: Int
  let tokenDelta: Int
  let onErrorDelta: Int

  var report: [String: Any] {
    [
      "code": code,
      "onErrorDelta": onErrorDelta,
      "submissionDelta": submissionDelta,
      "tokenDelta": tokenDelta,
    ]
  }
}

func expectFailure(
  code: VGPUErrorCode,
  backend: RecordingBackend,
  gpu: VGPU,
  errors: ErrorRecorder,
  operation: () throws -> Void
) throws -> FailureEvidence {
  let submissions = backend.frameSubmissions
  let pending = gpu._pendingWorkCount
  let onErrorCount = errors.count
  let actualCode: String
  do {
    try operation()
    throw ProbeError(description: "expected synchronous failure \(code.rawValue)")
  } catch let error as VGPUError {
    try require(error.code == code, "unexpected error code \(error.code.rawValue)")
    actualCode = error.code.rawValue
  }
  let evidence = FailureEvidence(
    code: actualCode,
    submissionDelta: backend.frameSubmissions - submissions,
    tokenDelta: gpu._pendingWorkCount - pending,
    onErrorDelta: errors.count - onErrorCount
  )
  try require(evidence.submissionDelta == 0, "failed frame reached the backend")
  try require(evidence.tokenDelta == 0, "failed frame registered a token")
  try require(evidence.onErrorDelta == 0, "synchronous failure reached onError")
  return evidence
}

@MainActor
func run() async throws {
  try require(
    ProducePacket._vgpuProgramDescriptor.artifact
      == ConsumePacket._vgpuDrawProgramDescriptor.artifact,
    "compute and draw descriptors did not share one artifact witness"
  )
  let backend = RecordingBackend(contextIdentity: 100)
  let gpu = VGPU(backend: backend)
  let errors = ErrorRecorder()
  let unsubscribe = gpu.onError { error in errors.record(error) }
  let values: [UInt32] = [0, 0, 0, 0, 3, 1, 3, 0]
  let arguments = try gpu.storage(
    UInt32.self,
    count: 8,
    access: .readWrite,
    additionalUsage: [.indirect],
    initial: values
  )
  let producer = try gpu.compute(
    ProducePacket.self,
    bindings: .init(output: arguments)
  )
  let computeSubmission = try producer.dispatch(x: 1)
  let outerView = try arguments.buffer.slice(bytes: 8..<32)
  let view = try outerView.slice(bytes: 8..<24)
  let draw = try gpu.draw(ConsumePacket.self, vertices: 0)
  let target = try gpu.target(width: 4, height: 4)
  let frameSubmission = try gpu.frame { frame in
    try frame.pass(target: target) { pass in
      try pass.draw(draw, indirect: view)
    }
  }

  try require(backend.trace == ["computeCommit", "frameCommit"], "commit order drifted")
  try require(gpu._pendingWorkCount == 2, "commits completed before the gate opened")
  try require(backend.storageReads == 0, "compute-to-draw performed a CPU read")
  let evidence = backend.evidence
  try require(
    evidence.computeIdentity == evidence.drawIdentity
      && evidence.computeGeneration == evidence.drawGeneration,
    "compute and draw did not share one allocation generation"
  )
  try require(evidence.viewRange == 16..<32, "indirect view range drifted")
  try require(evidence.consumerByteOffset == 0, "consumer offset drifted")
  try require(evidence.physicalByteOffset == 16, "physical offset drifted")
  try require(evidence.directVertexCount == 0, "direct draw count was not zero")
  try require(evidence.renderedArguments == [3, 1, 0, 0], "compute arguments were stale")
  try require(evidence.renderedGreen, "indirect draw selected the stale red vertices")

  let noUsage = try gpu.storage(UInt32.self, count: 8, initial: values)
  let noUsageView = try noUsage.buffer.slice(bytes: 16..<32)
  let missingUsageFailure = try expectFailure(
    code: .invalidIndirect,
    backend: backend,
    gpu: gpu,
    errors: errors
  ) {
    _ = try gpu.frame { frame in
      try frame.pass(target: target) { pass in
        try pass.draw(draw, indirect: noUsageView)
      }
    }
  }

  let foreignBackend = RecordingBackend(contextIdentity: 200)
  let foreignGPU = VGPU(backend: foreignBackend)
  let foreign = try foreignGPU.storage(
    UInt32.self,
    count: 8,
    additionalUsage: [.indirect],
    initial: values
  )
  let foreignView = try foreign.buffer.slice(bytes: 16..<32)
  let foreignContextFailure = try expectFailure(
    code: .contextMismatch,
    backend: backend,
    gpu: gpu,
    errors: errors
  ) {
    _ = try gpu.frame { frame in
      try frame.pass(target: target) { pass in
        try pass.draw(draw, indirect: foreignView)
      }
    }
  }

  let misalignedStorage = try gpu.storage(
    UInt32.self,
    count: 9,
    additionalUsage: [.indirect]
  )
  let misalignedView = try misalignedStorage.buffer.slice(bytes: 18..<34)
  let misalignedFailure = try expectFailure(
    code: .invalidIndirect,
    backend: backend,
    gpu: gpu,
    errors: errors
  ) {
    _ = try gpu.frame { frame in
      try frame.pass(target: target) { pass in
        try pass.draw(draw, indirect: misalignedView)
      }
    }
  }

  let shortView = try arguments.buffer.slice(bytes: 16..<28)
  let shortRangeFailure = try expectFailure(
    code: .invalidIndirect,
    backend: backend,
    gpu: gpu,
    errors: errors
  ) {
    _ = try gpu.frame { frame in
      try frame.pass(target: target) { pass in
        try pass.draw(draw, indirect: shortView)
      }
    }
  }

  let overflowView = VGPUBuffer(
    sizeInBytes: 16,
    usage: [.indirect],
    box: OverflowStorageBox(contextIdentity: backend.contextIdentity),
    backingByteRange: 12..<28
  )
  let overflowFailure = try expectFailure(
    code: .invalidIndirect,
    backend: backend,
    gpu: gpu,
    errors: errors
  ) {
    _ = try gpu.frame { frame in
      try frame.pass(target: target) { pass in
        try pass.draw(draw, indirect: overflowView)
      }
    }
  }

  try require(
    backend.trace == ["computeCommit", "frameCommit"] && backend.storageReads == 0,
    "negative cases changed the accepted trace"
  )
  await backend.gate.releaseAll()
  await computeSubmission.settled()
  await frameSubmission.settled()
  try require(errors.count == 0, "accepted work unexpectedly reached onError")
  unsubscribe()
  try misalignedStorage.dispose()
  try noUsage.dispose()
  try arguments.dispose()
  try foreign.dispose()
  try foreignGPU.dispose()
  try gpu.dispose()

  let report: [String: Any] = [
    "commitTrace": backend.trace,
    "consumerByteOffset": evidence.consumerByteOffset!,
    "directVertexCount": evidence.directVertexCount!,
    "gate": "dc1-compute-draw-recording",
    "nestedSlice": true,
    "noCPUReadOrWait": true,
    "physicalByteOffset": evidence.physicalByteOffset!,
    "renderedArguments": evidence.renderedArguments,
    "renderedColor": "green",
    "sameAllocationGeneration": true,
    "schemaVersion": 1,
    "status": "passed",
    "synchronousFailures": [
      "foreignContext": foreignContextFailure.report,
      "misalignedOffset": misalignedFailure.report,
      "missingIndirectUsage": missingUsageFailure.report,
      "offsetOverflow": overflowFailure.report,
      "shortRange": shortRangeFailure.report,
    ],
    "viewRange": [evidence.viewRange!.lowerBound, evidence.viewRange!.upperBound],
  ]
  let data = try JSONSerialization.data(withJSONObject: report, options: [.sortedKeys])
  print(String(decoding: data, as: UTF8.self))
}

@main
enum DC1RecordingProbe {
  static func main() async {
    do {
      try await run()
    } catch {
      FileHandle.standardError.write(Data("\(error)\n".utf8))
      Darwin.exit(1)
    }
  }
}
