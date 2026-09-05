import Foundation
import GeneratedFixture
import VGPUABI
import VGPUResources
import _VGPUBackendSPI

struct RecordingProbeError: Error, CustomStringConvertible {
  let description: String
}

func fail(_ message: String) throws -> Never {
  throw RecordingProbeError(description: message)
}

func require(_ condition: @autoclosure () throws -> Bool, _ message: String) throws {
  if try !condition() {
    try fail(message)
  }
}

enum RecordingBackendError: Error, CustomStringConvertible {
  case missingAllocation
  case range
  case byteCount
  case injectedReplacementFailure

  var description: String {
    switch self {
    case .missingAllocation: "recording allocation is missing"
    case .range: "recording backend range is invalid"
    case .byteCount: "recording backend replacement byte count differs"
    case .injectedReplacementFailure: "injected replacement failure"
    }
  }
}

final class RecordingStorageBackend: VGPUStorageBackend, @unchecked Sendable {
  private struct Allocation {
    var bytes: Data
    let logicalByteCount: Int
    let access: VGPUStorageAccess
    let identity: UInt64
    let generation: UInt64
    let offset: Int
  }

  private let lock = NSLock()
  private var nextHandle: UInt64 = 1
  private var allocations: [VGPUBackendStorageHandle: Allocation] = [:]
  private var shouldFailNextReplacement = false
  private let backingPrefixBytes: Int
  private let backingSuffixBytes: Int
  private let sentinelByte: UInt8
  private(set) var allocationCount = 0
  private(set) var replacementCount = 0
  private(set) var disposalCount = 0

  init(
    backingPrefixBytes: Int = 0,
    backingSuffixBytes: Int = 0,
    sentinelByte: UInt8 = 0xa5
  ) {
    precondition(backingPrefixBytes >= 0)
    precondition(backingSuffixBytes >= 0)
    self.backingPrefixBytes = backingPrefixBytes
    self.backingSuffixBytes = backingSuffixBytes
    self.sentinelByte = sentinelByte
  }

  func allocateStorage(
    initialBytes: Data,
    access: VGPUStorageAccess
  ) throws -> VGPUBackendStorageHandle {
    try withLock {
      let (prefixAndLogical, prefixOverflow) = backingPrefixBytes.addingReportingOverflow(
        initialBytes.count
      )
      let (backingByteCount, suffixOverflow) = prefixAndLogical.addingReportingOverflow(
        backingSuffixBytes
      )
      guard !prefixOverflow, !suffixOverflow else {
        throw RecordingBackendError.range
      }
      var backingBytes = Data(repeating: sentinelByte, count: backingByteCount)
      backingBytes.replaceSubrange(
        backingPrefixBytes..<prefixAndLogical,
        with: initialBytes
      )
      let handle = VGPUBackendStorageHandle(rawValue: nextHandle)
      nextHandle += 1
      allocations[handle] = Allocation(
        bytes: backingBytes,
        logicalByteCount: initialBytes.count,
        access: access,
        identity: handle.rawValue,
        generation: 1,
        offset: backingPrefixBytes
      )
      allocationCount += 1
      return handle
    }
  }

  func replaceStorageBytes(
    handle: VGPUBackendStorageHandle,
    range: Range<Int>,
    bytes: Data
  ) throws {
    try withLock {
      guard var allocation = allocations[handle] else {
        throw RecordingBackendError.missingAllocation
      }
      guard range.lowerBound >= 0, range.upperBound <= allocation.logicalByteCount else {
        throw RecordingBackendError.range
      }
      guard range.count == bytes.count else {
        throw RecordingBackendError.byteCount
      }
      if shouldFailNextReplacement {
        shouldFailNextReplacement = false
        throw RecordingBackendError.injectedReplacementFailure
      }
      let backingRange =
        (allocation.offset + range.lowerBound)..<(allocation.offset + range.upperBound)
      allocation.bytes.replaceSubrange(backingRange, with: bytes)
      allocations[handle] = allocation
      replacementCount += 1
    }
  }

  func readStorageBytes(
    handle: VGPUBackendStorageHandle,
    range: Range<Int>
  ) async throws -> Data {
    try readStorageBytesSynchronously(handle: handle, range: range)
  }

  func storageSnapshot(
    handle: VGPUBackendStorageHandle
  ) throws -> VGPUBackendStorageSnapshot {
    try withLock {
      guard let allocation = allocations[handle] else {
        throw RecordingBackendError.missingAllocation
      }
      return VGPUBackendStorageSnapshot(
        handle: handle,
        identity: allocation.identity,
        generation: allocation.generation,
        offset: allocation.offset,
        backingByteCount: allocation.bytes.count,
        access: allocation.access
      )
    }
  }

  func disposeStorage(handle: VGPUBackendStorageHandle) {
    withLock {
      if allocations.removeValue(forKey: handle) != nil {
        disposalCount += 1
      }
    }
  }

  func failNextReplacement() {
    withLock { shouldFailNextReplacement = true }
  }

  func bytes(for handle: VGPUBackendStorageHandle) throws -> Data {
    try withLock {
      guard let allocation = allocations[handle] else {
        throw RecordingBackendError.missingAllocation
      }
      let logicalRange =
        allocation.offset..<(allocation.offset + allocation.logicalByteCount)
      return allocation.bytes.subdata(in: logicalRange)
    }
  }

  func backingBytes(for handle: VGPUBackendStorageHandle) throws -> Data {
    try withLock {
      guard let allocation = allocations[handle] else {
        throw RecordingBackendError.missingAllocation
      }
      return allocation.bytes
    }
  }

  private func readStorageBytesSynchronously(
    handle: VGPUBackendStorageHandle,
    range: Range<Int>
  ) throws -> Data {
    try withLock {
      guard let allocation = allocations[handle] else {
        throw RecordingBackendError.missingAllocation
      }
      guard range.lowerBound >= 0, range.upperBound <= allocation.logicalByteCount else {
        throw RecordingBackendError.range
      }
      let backingRange =
        (allocation.offset + range.lowerBound)..<(allocation.offset + range.upperBound)
      return allocation.bytes.subdata(in: backingRange)
    }
  }

  private func withLock<T>(_ body: () throws -> T) rethrows -> T {
    lock.lock()
    defer { lock.unlock() }
    return try body()
  }
}

final class UntouchableStorageBox: _VGPURuntimeStorageBox, @unchecked Sendable {
  var isDisposed: Bool { false }

  func replaceBytes(in range: Range<Int>, with bytes: Data) throws {
    try fail("UInt32 binding gate touched its backing box")
  }

  func readBytes(in range: Range<Int>) async throws -> Data {
    try fail("UInt32 binding gate touched its backing box")
  }

  func dispose() throws {
    try fail("UInt32 binding gate touched its backing box")
  }
}

enum CanaryCodec {
  static func packWordPrefix(_ value: UInt32, byteCount: Int) -> Data {
    var bytes = Data(repeating: 0, count: byteCount)
    writeWord(value, to: &bytes, at: 0)
    return bytes
  }

  static func unpackWordPrefix(_ bytes: Data, byteCount: Int) throws -> UInt32 {
    guard bytes.count == byteCount else {
      try fail("canary prefix byte count drifted")
    }
    return readWord(bytes, at: 0)
  }

  static func packWordElement(_ value: UInt32, stride: Int) -> Data {
    var bytes = Data(repeating: 0, count: stride)
    writeWord(value, to: &bytes, at: 0)
    return bytes
  }

  static func unpackWordElement(_ bytes: Data, stride: Int) throws -> UInt32 {
    guard bytes.count == stride else {
      try fail("canary element byte count drifted")
    }
    return readWord(bytes, at: 0)
  }
}

enum FourByteMinimumValues: VGPURuntimeArrayLayout {
  typealias Prefix = UInt32
  typealias Element = UInt32

  static let _vgpuRuntimeArrayLayout = _VGPURuntimeArrayLayoutDescriptor(
    tailOffset: 4,
    elementStride: 4,
    minimumBindingSize: 16
  )

  static func _vgpuPackPrefix(_ value: UInt32) throws -> Data {
    CanaryCodec.packWordPrefix(value, byteCount: 4)
  }

  static func _vgpuUnpackPrefix(_ bytes: Data) throws -> UInt32 {
    try CanaryCodec.unpackWordPrefix(bytes, byteCount: 4)
  }

  static func _vgpuPackElement(_ value: UInt32) throws -> Data {
    CanaryCodec.packWordElement(value, stride: 4)
  }

  static func _vgpuUnpackElement(_ bytes: Data) throws -> UInt32 {
    try CanaryCodec.unpackWordElement(bytes, stride: 4)
  }
}

enum SixteenBytePrefixValues: VGPURuntimeArrayLayout {
  typealias Prefix = UInt32
  typealias Element = UInt32

  static let _vgpuRuntimeArrayLayout = _VGPURuntimeArrayLayoutDescriptor(
    tailOffset: 16,
    elementStride: 4,
    minimumBindingSize: 32
  )

  static func _vgpuPackPrefix(_ value: UInt32) throws -> Data {
    CanaryCodec.packWordPrefix(value, byteCount: 16)
  }

  static func _vgpuUnpackPrefix(_ bytes: Data) throws -> UInt32 {
    try CanaryCodec.unpackWordPrefix(bytes, byteCount: 16)
  }

  static func _vgpuPackElement(_ value: UInt32) throws -> Data {
    CanaryCodec.packWordElement(value, stride: 4)
  }

  static func _vgpuUnpackElement(_ bytes: Data) throws -> UInt32 {
    try CanaryCodec.unpackWordElement(bytes, stride: 4)
  }
}

enum PaddedMinimumValues: VGPURuntimeArrayLayout {
  typealias Prefix = UInt32
  typealias Element = UInt32

  static let _vgpuRuntimeArrayLayout = _VGPURuntimeArrayLayoutDescriptor(
    tailOffset: 4,
    elementStride: 12,
    minimumBindingSize: 32
  )

  static func _vgpuPackPrefix(_ value: UInt32) throws -> Data {
    CanaryCodec.packWordPrefix(value, byteCount: 4)
  }

  static func _vgpuUnpackPrefix(_ bytes: Data) throws -> UInt32 {
    try CanaryCodec.unpackWordPrefix(bytes, byteCount: 4)
  }

  static func _vgpuPackElement(_ value: UInt32) throws -> Data {
    CanaryCodec.packWordElement(value, stride: 12)
  }

  static func _vgpuUnpackElement(_ bytes: Data) throws -> UInt32 {
    try CanaryCodec.unpackWordElement(bytes, stride: 12)
  }
}

enum F16TailValues: VGPURuntimeArrayLayout {
  typealias Prefix = UInt32
  typealias Element = UInt16

  static let _vgpuRuntimeArrayLayout = _VGPURuntimeArrayLayoutDescriptor(
    tailOffset: 4,
    elementStride: 2,
    minimumBindingSize: 8
  )

  static func _vgpuPackPrefix(_ value: UInt32) throws -> Data {
    CanaryCodec.packWordPrefix(value, byteCount: 4)
  }

  static func _vgpuUnpackPrefix(_ bytes: Data) throws -> UInt32 {
    try CanaryCodec.unpackWordPrefix(bytes, byteCount: 4)
  }

  static func _vgpuPackElement(_ value: UInt16) throws -> Data {
    var littleEndian = value.littleEndian
    return Swift.withUnsafeBytes(of: &littleEndian) { Data($0) }
  }

  static func _vgpuUnpackElement(_ bytes: Data) throws -> UInt16 {
    guard bytes.count == 2 else {
      try fail("f16 canary element byte count drifted")
    }
    let values = [UInt8](bytes)
    return UInt16(values[0]) | (UInt16(values[1]) << 8)
  }
}

enum RootF16Values: VGPURuntimeArrayLayout {
  struct Prefix: Sendable {}
  typealias Element = UInt16

  static let _vgpuRuntimeArrayLayout = _VGPURuntimeArrayLayoutDescriptor(
    tailOffset: 0,
    elementStride: 2,
    minimumBindingSize: 2
  )

  static func _vgpuPackPrefix(_ value: Prefix) throws -> Data { Data() }

  static func _vgpuUnpackPrefix(_ bytes: Data) throws -> Prefix {
    guard bytes.isEmpty else {
      try fail("root array prefix must be empty")
    }
    return Prefix()
  }

  static func _vgpuPackElement(_ value: UInt16) throws -> Data {
    try F16TailValues._vgpuPackElement(value)
  }

  static func _vgpuUnpackElement(_ bytes: Data) throws -> UInt16 {
    try F16TailValues._vgpuUnpackElement(bytes)
  }
}

enum FaultingValues: VGPURuntimeArrayLayout {
  struct Element: Equatable, Sendable {
    let value: Int
  }

  typealias Prefix = UInt32

  static let _vgpuRuntimeArrayLayout = _VGPURuntimeArrayLayoutDescriptor(
    tailOffset: 4,
    elementStride: 4,
    minimumBindingSize: 8
  )

  static func _vgpuPackPrefix(_ value: UInt32) throws -> Data {
    CanaryCodec.packWordPrefix(value, byteCount: 4)
  }

  static func _vgpuUnpackPrefix(_ bytes: Data) throws -> UInt32 {
    try CanaryCodec.unpackWordPrefix(bytes, byteCount: 4)
  }

  static func _vgpuPackElement(_ value: Element) throws -> Data {
    guard value.value >= 0, value.value <= Int(UInt32.max) else {
      try fail("faulting layout rejected its element")
    }
    return CanaryCodec.packWordElement(UInt32(value.value), stride: 4)
  }

  static func _vgpuUnpackElement(_ bytes: Data) throws -> Element {
    Element(value: Int(try CanaryCodec.unpackWordElement(bytes, stride: 4)))
  }
}

enum UInt32RangeValues: VGPURuntimeArrayLayout {
  typealias Prefix = UInt32
  typealias Element = UInt32

  static let _vgpuRuntimeArrayLayout = _VGPURuntimeArrayLayoutDescriptor(
    tailOffset: 4,
    elementStride: Int(UInt32.max) - 3,
    minimumBindingSize: Int(UInt32.max) + 1
  )

  static func _vgpuPackPrefix(_ value: UInt32) throws -> Data {
    CanaryCodec.packWordPrefix(value, byteCount: 4)
  }

  static func _vgpuUnpackPrefix(_ bytes: Data) throws -> UInt32 {
    try CanaryCodec.unpackWordPrefix(bytes, byteCount: 4)
  }

  static func _vgpuPackElement(_ value: UInt32) throws -> Data {
    try fail("UInt32-range canary must fail before packing")
  }

  static func _vgpuUnpackElement(_ bytes: Data) throws -> UInt32 {
    try fail("UInt32-range canary must fail before decoding")
  }
}

enum MultiplyOverflowValues: VGPURuntimeArrayLayout {
  typealias Prefix = UInt32
  typealias Element = UInt32

  static let _vgpuRuntimeArrayLayout = _VGPURuntimeArrayLayoutDescriptor(
    tailOffset: 4,
    elementStride: Int.max / 2 + 1,
    minimumBindingSize: Int.max / 2 + 5
  )

  static func _vgpuPackPrefix(_ value: UInt32) throws -> Data {
    try fail("multiply-overflow canary must fail before packing")
  }

  static func _vgpuUnpackPrefix(_ bytes: Data) throws -> UInt32 {
    try fail("multiply-overflow canary must fail before decoding")
  }

  static func _vgpuPackElement(_ value: UInt32) throws -> Data {
    try fail("multiply-overflow canary must fail before packing")
  }

  static func _vgpuUnpackElement(_ bytes: Data) throws -> UInt32 {
    try fail("multiply-overflow canary must fail before decoding")
  }
}

func expectedFailure(
  _ label: String,
  containing expected: String,
  _ operation: () throws -> Void
) throws -> String {
  var received: Error?
  do {
    try operation()
  } catch {
    received = error
  }
  guard let received else {
    try fail("\(label) unexpectedly succeeded")
  }
  try require(
    String(describing: received).contains(expected),
    "\(label) returned an unexpected error: \(received)"
  )
  return label
}

func writeWord(_ value: UInt32, to bytes: inout Data, at offset: Int) {
  var littleEndian = value.littleEndian
  Swift.withUnsafeBytes(of: &littleEndian) { source in
    bytes.replaceSubrange(offset..<(offset + 4), with: source)
  }
}

func readWord(_ data: Data, at offset: Int) -> UInt32 {
  let bytes = [UInt8](data)
  return UInt32(bytes[offset])
    | (UInt32(bytes[offset + 1]) << 8)
    | (UInt32(bytes[offset + 2]) << 16)
    | (UInt32(bytes[offset + 3]) << 24)
}

func runRecordingProbe() async throws {
  let descriptor = Values._vgpuRuntimeArrayLayout
  try require(descriptor.tailOffset == 4, "fixture tail offset drifted")
  try require(descriptor.elementStride == 12, "fixture element stride drifted")
  try require(descriptor.minimumBindingSize == 16, "fixture binding minimum drifted")
  try require(try descriptor.rangeBytes(exactElementCount: 2) == 28, "short range drifted")
  try require(try descriptor.rangeBytes(exactElementCount: 4) == 52, "long range drifted")

  let backend = RecordingStorageBackend()
  let initial = [
    Particle(mass: 10, id: 101),
    Particle(mass: 20, id: 202),
    Particle(mass: 30, id: 303),
    Particle(mass: 40, id: 404),
  ]
  let gpu = VGPU(backend: backend)
  let values: Values.Storage = try gpu.storage(
    Values.self,
    prefix: .init(prefix: 77),
    capacity: 4,
    access: .readWrite,
    initialElements: initial
  )
  try require(values.capacity == 4, "resource capacity drifted")
  try require(values.elementStride == 12, "resource element stride drifted")
  try require(values.sizeInBytes == 52, "resource allocation size drifted")

  let short: Values.Binding = try values.binding(elementCount: 2)
  let long: Values.Binding = try values.binding(elementCount: 4)
  let shortSnapshot = try short._backendSnapshot(requiredAccess: .read)
  let longSnapshot = try long._backendSnapshot(requiredAccess: .readWrite)
  try require(short.sizeInBytes == 28 && long.sizeInBytes == 52, "view ranges drifted")
  try require(
    shortSnapshot.allocation.identity == longSnapshot.allocation.identity
      && shortSnapshot.allocation.generation == longSnapshot.allocation.generation
      && shortSnapshot.allocation.offset == longSnapshot.allocation.offset,
    "runtime views do not share identity, generation, and offset"
  )
  try require(
    shortSnapshot.boundByteCount == 28 && longSnapshot.boundByteCount == 52,
    "prepared view ranges drifted"
  )

  let initialBytes = try backend.bytes(for: shortSnapshot.allocation.handle)
  try require(initialBytes.count == 52, "recorded allocation byte count drifted")
  try require(readWord(initialBytes, at: 0) == 77, "prefix packing drifted")
  for (index, particle) in initial.enumerated() {
    let base = 4 + index * 12
    try require(readWord(initialBytes, at: base) == particle.mass, "mass packing drifted")
    try require(readWord(initialBytes, at: base + 8) == particle.id, "id packing drifted")
    try require(
      initialBytes[base + 4..<base + 8].allSatisfy { $0 == 0 },
      "element padding was not zero"
    )
  }

  try values.writePrefix(.init(prefix: 88))
  try values.writeElements(
    [Particle(mass: 33, id: 333), Particle(mass: 44, id: 444)],
    at: 2
  )
  let observedPrefix = try await values.readPrefix()
  let observedElements = try await values.readElements(range: 1..<4)
  try require(observedPrefix == .init(prefix: 88), "prefix readback drifted")
  try require(
    observedElements == [
      Particle(mass: 20, id: 202),
      Particle(mass: 33, id: 333),
      Particle(mass: 44, id: 444),
    ],
    "partial element readback drifted"
  )
  try values.writeElements(initial[0...0])

  var negativeChecks: [String] = []
  let beforeRangeFailure = try backend.bytes(for: shortSnapshot.allocation.handle)
  negativeChecks.append(
    try expectedFailure("element-range", containing: "exceeds capacity") {
      try values.writeElements(
        [Particle(mass: 1, id: 1), Particle(mass: 2, id: 2)],
        at: 3
      )
    }
  )
  negativeChecks.append(
    try expectedFailure("element-range-overflow", containing: "starting at") {
      try values.writeElements([Particle(mass: 1, id: 1)], at: Int.max)
    }
  )
  try require(
    try backend.bytes(for: shortSnapshot.allocation.handle) == beforeRangeFailure,
    "range failure mutated bytes"
  )

  let beforeBackendFailure = try backend.bytes(for: shortSnapshot.allocation.handle)
  backend.failNextReplacement()
  negativeChecks.append(
    try expectedFailure("backend-atomicity", containing: "injected replacement") {
      try values.writePrefix(.init(prefix: 99))
    }
  )
  try require(
    try backend.bytes(for: shortSnapshot.allocation.handle) == beforeBackendFailure,
    "backend failure mutated bytes"
  )
  let prefixAfterFailedWrite = try await values.readPrefix()
  try require(prefixAfterFailedWrite == .init(prefix: 88), "failed prefix write leaked")

  let faultingBackend = RecordingStorageBackend()
  let faultingGPU = VGPU(backend: faultingBackend)
  let faulting = try faultingGPU.storage(
    FaultingValues.self,
    prefix: 5,
    capacity: 2,
    access: .readWrite,
    initialElements: [.init(value: 1), .init(value: 2)]
  )
  let faultingView = try faulting.binding(elementCount: 2)
  let faultingSnapshot = try faultingView._backendSnapshot(requiredAccess: .read)
  let beforePackingFailure = try faultingBackend.bytes(
    for: faultingSnapshot.allocation.handle
  )
  negativeChecks.append(
    try expectedFailure("packer-atomicity", containing: "rejected its element") {
      try faulting.writeElements([.init(value: 7), .init(value: -1)], at: 0)
    }
  )
  try require(
    try faultingBackend.bytes(for: faultingSnapshot.allocation.handle)
      == beforePackingFailure,
    "packer failure mutated bytes"
  )
  let creationFailureBackend = RecordingStorageBackend()
  let creationFailureGPU = VGPU(backend: creationFailureBackend)
  negativeChecks.append(
    try expectedFailure("creation-packer-atomicity", containing: "rejected its element") {
      _ = try creationFailureGPU.storage(
        FaultingValues.self,
        prefix: 5,
        capacity: 2,
        initialElements: [.init(value: 7), .init(value: -1)]
      )
    }
  )
  try require(
    creationFailureBackend.allocationCount == 0,
    "creation packing failure allocated backend storage"
  )

  negativeChecks.append(
    try expectedFailure("zero-count", containing: "no exact binding range") {
      _ = try values.binding(elementCount: 0)
    }
  )
  negativeChecks.append(
    try expectedFailure("over-capacity", containing: "exceeds capacity") {
      _ = try values.binding(elementCount: 5)
    }
  )

  let readOnly = try gpu.storage(
    Values.self,
    prefix: .init(prefix: 1),
    capacity: 4,
    access: .read,
    initialElements: initial
  )
  let readOnlyView = try readOnly.binding(elementCount: 4)
  negativeChecks.append(
    try expectedFailure("access", containing: "cannot satisfy readWrite") {
      _ = try readOnlyView._backendSnapshot(requiredAccess: .readWrite)
    }
  )
  try readOnly.writePrefix(.init(prefix: 2))
  let readOnlyPrefix = try await readOnly.readPrefix()
  try require(
    readOnlyPrefix == .init(prefix: 2),
    "shader-read-only storage rejected a host upload"
  )

  let fourByte = FourByteMinimumValues._vgpuRuntimeArrayLayout
  let sixteenByte = SixteenBytePrefixValues._vgpuRuntimeArrayLayout
  let padded = PaddedMinimumValues._vgpuRuntimeArrayLayout
  let f16Tail = F16TailValues._vgpuRuntimeArrayLayout
  let rootF16 = RootF16Values._vgpuRuntimeArrayLayout
  negativeChecks.append(
    try expectedFailure("o4-s4-count1", containing: "not exactly representable") {
      _ = try fourByte.rangeBytes(exactElementCount: 1)
    }
  )
  negativeChecks.append(
    try expectedFailure("o4-s4-count2", containing: "not exactly representable") {
      _ = try fourByte.rangeBytes(exactElementCount: 2)
    }
  )
  try require(try fourByte.rangeBytes(exactElementCount: 3) == 16, "O4/S4/M16 count 3")
  negativeChecks.append(
    try expectedFailure("o16-s4-count3", containing: "not exactly representable") {
      _ = try sixteenByte.rangeBytes(exactElementCount: 3)
    }
  )
  try require(
    try sixteenByte.rangeBytes(exactElementCount: 4) == 32,
    "O16/S4/M32 count 4"
  )
  negativeChecks.append(
    try expectedFailure("padded-count1", containing: "not exactly representable") {
      _ = try padded.rangeBytes(exactElementCount: 1)
    }
  )
  try require(
    try padded.rangeBytes(exactElementCount: 2) == 32,
    "O4/S12/M32 count 2 padding"
  )
  negativeChecks.append(
    try expectedFailure("f16-tail-odd", containing: "not exactly representable") {
      _ = try f16Tail.rangeBytes(exactElementCount: 3)
    }
  )
  try require(try f16Tail.rangeBytes(exactElementCount: 4) == 12, "f16 tail even count")
  negativeChecks.append(
    try expectedFailure("root-f16-odd", containing: "not exactly representable") {
      _ = try rootF16.rangeBytes(exactElementCount: 1)
    }
  )
  try require(try rootF16.rangeBytes(exactElementCount: 2) == 4, "root f16 even count")
  negativeChecks.append(
    try expectedFailure("capacity-hole", containing: "no exact binding range") {
      _ = try gpu.storage(
        PaddedMinimumValues.self,
        prefix: 0,
        capacity: 1,
        access: .read
      )
    }
  )
  negativeChecks.append(
    try expectedFailure("uint32-range", containing: "exceeds UInt32") {
      _ = try UInt32RangeValues._vgpuRuntimeArrayLayout.rangeBytes(exactElementCount: 1)
    }
  )
  let additionOverflow = _VGPURuntimeArrayLayoutDescriptor(
    tailOffset: Int.max - 100,
    elementStride: 60,
    minimumBindingSize: Int.max - 40
  )
  negativeChecks.append(
    try expectedFailure("range-addition-overflow", containing: "overflowed Int") {
      _ = try additionOverflow.rangeBytes(exactElementCount: 2)
    }
  )
  let roundUpOverflow = _VGPURuntimeArrayLayoutDescriptor(
    tailOffset: Int.max - 8,
    elementStride: 4,
    minimumBindingSize: Int.max
  )
  negativeChecks.append(
    try expectedFailure("range-round-up-overflow", containing: "overflowed Int") {
      _ = try roundUpOverflow.rangeBytes(exactElementCount: 1)
    }
  )
  let incompleteMinimum = _VGPURuntimeArrayLayoutDescriptor(
    tailOffset: 4,
    elementStride: 12,
    minimumBindingSize: 8
  )
  negativeChecks.append(
    try expectedFailure("descriptor-minimum", containing: "descriptor is invalid") {
      _ = try incompleteMinimum.rangeBytes(exactElementCount: 1)
    }
  )
  let allocationsBeforeArithmeticOverflow = backend.allocationCount
  negativeChecks.append(
    try expectedFailure("range-multiply-overflow", containing: "overflowed Int") {
      _ = try gpu.storage(
        MultiplyOverflowValues.self,
        prefix: 0,
        capacity: 2,
        access: .read
      )
    }
  )
  try require(
    backend.allocationCount == allocationsBeforeArithmeticOverflow,
    "arithmetic overflow allocated backend storage"
  )
  let allocationsBeforeUInt32Factory = backend.allocationCount
  negativeChecks.append(
    try expectedFailure("uint32-factory", containing: "exceeds UInt32") {
      _ = try gpu.storage(
        UInt32RangeValues.self,
        prefix: 0,
        capacity: 1,
        access: .read
      )
    }
  )
  try require(
    backend.allocationCount == allocationsBeforeUInt32Factory,
    "UInt32 factory failure allocated backend storage"
  )
  let forgedUInt32Storage = VGPURuntimeStorage<UInt32RangeValues>(
    capacity: 1,
    elementStride: UInt32RangeValues._vgpuRuntimeArrayLayout.elementStride,
    sizeInBytes: 8,
    access: .read,
    box: UntouchableStorageBox()
  )
  negativeChecks.append(
    try expectedFailure("uint32-binding", containing: "exceeds UInt32") {
      _ = try forgedUInt32Storage.binding(elementCount: 1)
    }
  )
  let paddedCapacity = try gpu.storage(
    PaddedMinimumValues.self,
    prefix: 0,
    capacity: 2,
    access: .read,
    initialElements: [1, 2]
  )
  try require(paddedCapacity.sizeInBytes == 32, "padded capacity range drifted")

  let suballocatedBackend = RecordingStorageBackend(
    backingPrefixBytes: 16,
    backingSuffixBytes: 20
  )
  let suballocatedGPU = VGPU(backend: suballocatedBackend)
  let suballocated = try suballocatedGPU.storage(
    Values.self,
    prefix: .init(prefix: 7),
    capacity: 4,
    initialElements: initial
  )
  let suballocatedShort = try suballocated.binding(elementCount: 2)
  let suballocatedLong = try suballocated.binding(elementCount: 4)
  let suballocatedShortSnapshot = try suballocatedShort._backendSnapshot(
    requiredAccess: .read
  )
  let suballocatedLongSnapshot = try suballocatedLong._backendSnapshot(
    requiredAccess: .readWrite
  )
  try require(
    suballocated.sizeInBytes == 52
      && suballocatedShortSnapshot.boundByteCount == 28
      && suballocatedLongSnapshot.boundByteCount == 52,
    "suballocated logical ranges drifted"
  )
  try require(
    suballocatedLongSnapshot.allocation.offset == 16
      && suballocatedLongSnapshot.allocation.backingByteCount == 88,
    "suballocated backing extent drifted"
  )
  try require(
    suballocatedLongSnapshot.allocation.offset % 4 == 0,
    "suballocated backing offset is not storage-aligned"
  )
  try suballocated.writePrefix(.init(prefix: 9))
  try suballocated.writeElements([Particle(mass: 50, id: 505)], at: 3)
  let suballocatedPrefix = try await suballocated.readPrefix()
  let suballocatedElements = try await suballocated.readElements(range: 3..<4)
  try require(
    suballocatedPrefix == .init(prefix: 9),
    "suballocated prefix readback drifted"
  )
  try require(
    suballocatedElements == [Particle(mass: 50, id: 505)],
    "suballocated element readback drifted"
  )
  let suballocatedBacking = try suballocatedBackend.backingBytes(
    for: suballocatedLongSnapshot.allocation.handle
  )
  try require(
    suballocatedBacking[0..<16].allSatisfy { $0 == 0xa5 }
      && suballocatedBacking[68..<88].allSatisfy { $0 == 0xa5 },
    "suballocated writes escaped their logical range"
  )

  let sparse = try gpu.storage(
    Values.self,
    prefix: .init(prefix: 3),
    capacity: 4,
    initialElements: [Particle(mass: 5, id: 6)]
  )
  try require(sparse.access == .readWrite, "default storage access drifted")
  let sparseSnapshot = try sparse.binding(elementCount: 4)._backendSnapshot(
    requiredAccess: .readWrite
  )
  let sparseBytes = try backend.bytes(for: sparseSnapshot.allocation.handle)
  try require(
    sparseBytes[16..<52].allSatisfy { $0 == 0 },
    "unused capacity was not zero-initialized"
  )
  try sparse.dispose()

  let metadataAfterFailures = try long._backendSnapshot(requiredAccess: .readWrite)
  try require(metadataAfterFailures == longSnapshot, "failure changed resource metadata")

  let disposableBackend = RecordingStorageBackend()
  let disposableGPU = VGPU(backend: disposableBackend)
  let disposable = try disposableGPU.storage(
    Values.self,
    prefix: .init(prefix: 7),
    capacity: 1,
    access: .read,
    initialElements: [Particle(mass: 1, id: 2)]
  )
  try disposable.dispose()
  try disposable.dispose()
  try require(disposable._isDisposed, "disposed state did not persist")
  try require(disposableBackend.disposalCount == 1, "dispose was not idempotent")
  negativeChecks.append(
    try expectedFailure("disposed-binding", containing: "disposed") {
      _ = try disposable.binding(elementCount: 1)
    }
  )
  negativeChecks.append(
    try expectedFailure("disposed-empty-write", containing: "disposed") {
      try disposable.writeElements([], at: 0)
    }
  )

  let finalBytes = try backend.bytes(for: shortSnapshot.allocation.handle)
  let report: [String: Any] = [
    "access": ["hostWriteToShaderReadStorage": true, "readWriteRejected": true],
    "allocationBytes": values.sizeInBytes,
    "canaryRanges": [
      "o4s4m16n3": try fourByte.rangeBytes(exactElementCount: 3),
      "o16s4m32n4": try sixteenByte.rangeBytes(exactElementCount: 4),
      "o4s12m32n2": try padded.rangeBytes(exactElementCount: 2),
      "o4s2m8n4": try f16Tail.rangeBytes(exactElementCount: 4),
      "o0s2m2n2": try rootF16.rangeBytes(exactElementCount: 2),
    ],
    "disposeIdempotent": disposableBackend.disposalCount == 1,
    "elementReadback": observedElements.map { ["id": $0.id, "mass": $0.mass] },
    "negativeChecks": negativeChecks,
    "paddingZero": [8, 20, 32, 44].allSatisfy { offset in
      finalBytes[offset..<offset + 4].allSatisfy { $0 == 0 }
    },
    "prefixReadback": observedPrefix.prefix,
    "ranges": [short.sizeInBytes, long.sizeInBytes],
    "suballocation": [
      "backingBytes": suballocatedLongSnapshot.allocation.backingByteCount,
      "logicalBytes": suballocated.sizeInBytes,
      "offset": suballocatedLongSnapshot.allocation.offset,
    ],
    "sameBacking": [
      "generation": shortSnapshot.allocation.generation
        == longSnapshot.allocation.generation,
      "identity": shortSnapshot.allocation.identity == longSnapshot.allocation.identity,
      "offset": shortSnapshot.allocation.offset == longSnapshot.allocation.offset,
    ],
  ]
  let data = try JSONSerialization.data(
    withJSONObject: report,
    options: [.sortedKeys, .withoutEscapingSlashes]
  )
  guard let json = String(data: data, encoding: .utf8) else {
    try fail("could not encode recording report")
  }
  print(json)
}

@main
enum RecordingProbe {
  static func main() async throws {
    try await runRecordingProbe()
  }
}
