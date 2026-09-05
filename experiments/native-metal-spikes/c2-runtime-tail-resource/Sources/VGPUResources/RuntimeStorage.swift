import Foundation
import VGPUABI
import _VGPUBackendSPI

package enum VGPURuntimeStorageError: Error, Equatable, CustomStringConvertible, Sendable {
  case capacityMustBePositive(Int)
  case capacityNotRepresentable(Int)
  case tooManyInitialElements(capacity: Int, actual: Int)
  case elementCountExceedsCapacity(capacity: Int, actual: Int)
  case elementCountNotRepresentable(Int)
  case elementRange(start: Int, count: Int, capacity: Int)
  case packedPrefixByteCount(expected: Int, actual: Int)
  case packedElementByteCount(expected: Int, actual: Int)
  case decodedPrefixByteCount(expected: Int, actual: Int)
  case decodedElementByteCount(expected: Int, actual: Int)
  case incompatibleAccess(required: VGPUStorageAccess, actual: VGPUStorageAccess)
  case disposed
  case backendContract(String)

  package var description: String {
    switch self {
    case .capacityMustBePositive(let value):
      "Storage capacity must be positive; received \(value)."
    case .capacityNotRepresentable(let value):
      "Storage capacity \(value) has no exact binding range."
    case .tooManyInitialElements(let capacity, let actual):
      "Initial element count \(actual) exceeds capacity \(capacity)."
    case .elementCountExceedsCapacity(let capacity, let actual):
      "Binding element count \(actual) exceeds capacity \(capacity)."
    case .elementCountNotRepresentable(let value):
      "Binding element count \(value) has no exact binding range."
    case .elementRange(let start, let count, let capacity):
      "Element operation starting at \(start) with \(count) values exceeds capacity \(capacity)."
    case .packedPrefixByteCount(let expected, let actual):
      "Packed prefix has \(actual) bytes; expected \(expected)."
    case .packedElementByteCount(let expected, let actual):
      "Packed element has \(actual) bytes; expected stride \(expected)."
    case .decodedPrefixByteCount(let expected, let actual):
      "Prefix read returned \(actual) bytes; expected \(expected)."
    case .decodedElementByteCount(let expected, let actual):
      "Element read returned \(actual) bytes; expected stride \(expected)."
    case .incompatibleAccess(let required, let actual):
      "Storage access \(actual.rawValue) cannot satisfy \(required.rawValue)."
    case .disposed:
      "The runtime storage resource is disposed."
    case .backendContract(let message):
      "The storage backend violated its contract: \(message)"
    }
  }
}

private final class RuntimeStorageBox: _VGPURuntimeStorageBox, @unchecked Sendable {
  private let lock = NSLock()
  private let backend: any VGPUStorageBackend
  private var handle: VGPUBackendStorageHandle?

  init(backend: any VGPUStorageBackend, handle: VGPUBackendStorageHandle) {
    self.backend = backend
    self.handle = handle
  }

  var isDisposed: Bool {
    withLock { handle == nil }
  }

  func replaceBytes(in range: Range<Int>, with bytes: Data) throws {
    let current = try currentHandle()
    try backend.replaceStorageBytes(handle: current, range: range, bytes: bytes)
  }

  func readBytes(in range: Range<Int>) async throws -> Data {
    let current = try currentHandle()
    return try await backend.readStorageBytes(handle: current, range: range)
  }

  func snapshot() throws -> VGPUBackendStorageSnapshot {
    try backend.storageSnapshot(handle: currentHandle())
  }

  func dispose() throws {
    let released: VGPUBackendStorageHandle? = withLock {
      defer { handle = nil }
      return handle
    }
    if let released {
      backend.disposeStorage(handle: released)
    }
  }

  private func currentHandle() throws -> VGPUBackendStorageHandle {
    try withLock {
      guard let handle else {
        throw VGPURuntimeStorageError.disposed
      }
      return handle
    }
  }

  private func withLock<T>(_ body: () throws -> T) rethrows -> T {
    lock.lock()
    defer { lock.unlock() }
    return try body()
  }
}

package enum VGPURuntimeStorageFactory {
  package static func make<Layout: VGPURuntimeArrayLayout>(
    _ layout: Layout.Type,
    backend: any VGPUStorageBackend,
    capacity: Int,
    access: VGPUStorageAccess,
    prefix: Layout.Prefix,
    elements: [Layout.Element] = []
  ) throws -> VGPURuntimeStorage<Layout> {
    guard capacity > 0 else {
      throw VGPURuntimeStorageError.capacityMustBePositive(capacity)
    }
    guard elements.count <= capacity else {
      throw VGPURuntimeStorageError.tooManyInitialElements(
        capacity: capacity,
        actual: elements.count
      )
    }

    let descriptor = Layout._vgpuRuntimeArrayLayout
    let logicalByteCount: Int
    do {
      logicalByteCount = try descriptor.rangeBytes(exactElementCount: capacity)
    } catch VGPURuntimeArrayLayoutError.unrepresentableElementCount {
      throw VGPURuntimeStorageError.capacityNotRepresentable(capacity)
    }

    let prefixBytes = try Layout._vgpuPackPrefix(prefix)
    guard prefixBytes.count == descriptor.tailOffset else {
      throw VGPURuntimeStorageError.packedPrefixByteCount(
        expected: descriptor.tailOffset,
        actual: prefixBytes.count
      )
    }

    var initialBytes = Data(repeating: 0, count: logicalByteCount)
    initialBytes.replaceSubrange(0..<descriptor.tailOffset, with: prefixBytes)
    for (index, element) in elements.enumerated() {
      let bytes = try packedElement(element, layout: Layout.self)
      let offset = try elementOffset(index, descriptor: descriptor)
      initialBytes.replaceSubrange(offset..<(offset + descriptor.elementStride), with: bytes)
    }

    let handle = try backend.allocateStorage(initialBytes: initialBytes, access: access)
    let box = RuntimeStorageBox(backend: backend, handle: handle)
    return VGPURuntimeStorage(
      capacity: capacity,
      elementStride: descriptor.elementStride,
      sizeInBytes: logicalByteCount,
      access: access,
      box: box
    )
  }
}

/// Minimal stand-in for the core context, used only to prove the Resources extension shape.
public final class VGPU {
  private let backend: any VGPUStorageBackend

  package init(backend: any VGPUStorageBackend) {
    self.backend = backend
  }

  public func storage<Layout: VGPURuntimeArrayLayout>(
    _ layout: Layout.Type,
    prefix: Layout.Prefix,
    capacity: Int,
    access: VGPUStorageAccess = .readWrite,
    initialElements: [Layout.Element] = []
  ) throws -> VGPURuntimeStorage<Layout> {
    try VGPURuntimeStorageFactory.make(
      layout,
      backend: backend,
      capacity: capacity,
      access: access,
      prefix: prefix,
      elements: initialElements
    )
  }
}

extension VGPURuntimeStorage {
  package var _isDisposed: Bool { _box.isDisposed }

  public func binding(elementCount: Int) throws -> VGPURuntimeStorageBinding<Layout> {
    guard elementCount <= capacity else {
      throw VGPURuntimeStorageError.elementCountExceedsCapacity(
        capacity: capacity,
        actual: elementCount
      )
    }
    let rangeBytes: Int
    do {
      rangeBytes = try Layout._vgpuRuntimeArrayLayout.rangeBytes(
        exactElementCount: elementCount
      )
    } catch VGPURuntimeArrayLayoutError.invalidElementCount {
      throw VGPURuntimeStorageError.elementCountNotRepresentable(elementCount)
    } catch VGPURuntimeArrayLayoutError.unrepresentableElementCount {
      throw VGPURuntimeStorageError.elementCountNotRepresentable(elementCount)
    }
    guard !_box.isDisposed else {
      throw VGPURuntimeStorageError.disposed
    }
    return VGPURuntimeStorageBinding(
      storage: self,
      elementCount: elementCount,
      sizeInBytes: rangeBytes
    )
  }

  public func writePrefix(_ value: Layout.Prefix) throws {
    let descriptor = Layout._vgpuRuntimeArrayLayout
    let bytes = try Layout._vgpuPackPrefix(value)
    guard bytes.count == descriptor.tailOffset else {
      throw VGPURuntimeStorageError.packedPrefixByteCount(
        expected: descriptor.tailOffset,
        actual: bytes.count
      )
    }
    try _box.replaceBytes(in: 0..<descriptor.tailOffset, with: bytes)
  }

  public func readPrefix(
    isolation: isolated (any Actor)? = #isolation
  ) async throws -> Layout.Prefix {
    let expected = Layout._vgpuRuntimeArrayLayout.tailOffset
    let bytes = try await _box.readBytes(in: 0..<expected)
    guard bytes.count == expected else {
      throw VGPURuntimeStorageError.decodedPrefixByteCount(
        expected: expected,
        actual: bytes.count
      )
    }
    return try Layout._vgpuUnpackPrefix(bytes)
  }

  public func writeElements<Elements: Collection>(
    _ elements: Elements,
    at index: Int = 0
  ) throws where Elements.Element == Layout.Element {
    try validateElementRange(start: index, count: elements.count)
    if elements.isEmpty { return }

    let descriptor = Layout._vgpuRuntimeArrayLayout
    let byteCount = try checkedElementByteCount(
      elements.count,
      descriptor: descriptor
    )
    var bytes = Data(capacity: byteCount)
    for element in elements {
      try bytes.append(packedElement(element, layout: Layout.self))
    }
    let start = try elementOffset(index, descriptor: descriptor)
    let end = try checkedAdd(start, bytes.count)
    try _box.replaceBytes(in: start..<end, with: bytes)
  }

  public func readElements(
    range: Range<Int>,
    isolation: isolated (any Actor)? = #isolation
  ) async throws -> [Layout.Element] {
    let (count, countOverflow) = range.upperBound.subtractingReportingOverflow(
      range.lowerBound
    )
    guard !countOverflow else {
      throw VGPURuntimeArrayLayoutError.arithmeticOverflow
    }
    try validateElementRange(start: range.lowerBound, count: count)
    if range.isEmpty { return [] }

    let descriptor = Layout._vgpuRuntimeArrayLayout
    let start = try elementOffset(range.lowerBound, descriptor: descriptor)
    let byteCount = try checkedElementByteCount(count, descriptor: descriptor)
    let end = try checkedAdd(start, byteCount)
    let bytes = try await _box.readBytes(in: start..<end)
    guard bytes.count == byteCount else {
      throw VGPURuntimeStorageError.backendContract(
        "element read returned \(bytes.count) bytes instead of \(byteCount)"
      )
    }

    return try (0..<count).map { index in
      let elementStart = index * descriptor.elementStride
      let elementBytes = bytes.subdata(
        in: elementStart..<(elementStart + descriptor.elementStride)
      )
      guard elementBytes.count == descriptor.elementStride else {
        throw VGPURuntimeStorageError.decodedElementByteCount(
          expected: descriptor.elementStride,
          actual: elementBytes.count
        )
      }
      return try Layout._vgpuUnpackElement(elementBytes)
    }
  }

  public func dispose() throws {
    try _box.dispose()
  }

  package func _backendSnapshot(
    requiredAccess: VGPUStorageAccess,
    elementCount: Int,
    boundByteCount: Int
  ) throws -> VGPUPreparedRuntimeStorageBinding {
    guard access.satisfies(requiredAccess) else {
      throw VGPURuntimeStorageError.incompatibleAccess(
        required: requiredAccess,
        actual: access
      )
    }
    guard
      let box = _box as? RuntimeStorageBox
    else {
      throw VGPURuntimeStorageError.backendContract("unknown type-erased storage box")
    }
    let snapshot = try box.snapshot()
    guard snapshot.access == access else {
      throw VGPURuntimeStorageError.backendContract(
        "allocation access changed from \(access.rawValue) to \(snapshot.access.rawValue)"
      )
    }
    guard boundByteCount > 0, boundByteCount <= sizeInBytes else {
      throw VGPURuntimeStorageError.backendContract(
        "bound byte count \(boundByteCount) exceeds logical size \(sizeInBytes)"
      )
    }
    let (logicalEnd, logicalEndOverflow) = snapshot.offset.addingReportingOverflow(sizeInBytes)
    guard
      snapshot.offset >= 0,
      snapshot.backingByteCount >= 0,
      !logicalEndOverflow,
      logicalEnd <= snapshot.backingByteCount
    else {
      throw VGPURuntimeStorageError.backendContract(
        "logical range \(snapshot.offset)+\(sizeInBytes) exceeds backing size "
          + "\(snapshot.backingByteCount)"
      )
    }
    return VGPUPreparedRuntimeStorageBinding(
      allocation: snapshot,
      boundByteCount: boundByteCount,
      elementCount: elementCount
    )
  }

  private func validateElementRange(start: Int, count: Int) throws {
    guard !_box.isDisposed else {
      throw VGPURuntimeStorageError.disposed
    }
    guard start >= 0, count >= 0 else {
      throw VGPURuntimeStorageError.elementRange(
        start: start,
        count: count,
        capacity: capacity
      )
    }
    let (end, overflow) = start.addingReportingOverflow(count)
    guard !overflow, end <= capacity else {
      throw VGPURuntimeStorageError.elementRange(
        start: start,
        count: count,
        capacity: capacity
      )
    }
  }
}

extension VGPURuntimeStorageBinding {
  package func _backendSnapshot(
    requiredAccess: VGPUStorageAccess
  ) throws -> VGPUPreparedRuntimeStorageBinding {
    try _storage._backendSnapshot(
      requiredAccess: requiredAccess,
      elementCount: elementCount,
      boundByteCount: sizeInBytes
    )
  }
}

private func packedElement<Layout: VGPURuntimeArrayLayout>(
  _ element: Layout.Element,
  layout: Layout.Type
) throws -> Data {
  let expected = Layout._vgpuRuntimeArrayLayout.elementStride
  let bytes = try Layout._vgpuPackElement(element)
  guard bytes.count == expected else {
    throw VGPURuntimeStorageError.packedElementByteCount(
      expected: expected,
      actual: bytes.count
    )
  }
  return bytes
}

private func elementOffset(
  _ index: Int,
  descriptor: _VGPURuntimeArrayLayoutDescriptor
) throws -> Int {
  let (tailBytes, multiplyOverflow) = descriptor.elementStride.multipliedReportingOverflow(
    by: index
  )
  guard !multiplyOverflow else {
    throw VGPURuntimeArrayLayoutError.arithmeticOverflow
  }
  let (offset, additionOverflow) = descriptor.tailOffset.addingReportingOverflow(tailBytes)
  guard !additionOverflow else {
    throw VGPURuntimeArrayLayoutError.arithmeticOverflow
  }
  return offset
}

private func checkedElementByteCount(
  _ count: Int,
  descriptor: _VGPURuntimeArrayLayoutDescriptor
) throws -> Int {
  let (byteCount, overflow) = descriptor.elementStride.multipliedReportingOverflow(by: count)
  guard !overflow else {
    throw VGPURuntimeArrayLayoutError.arithmeticOverflow
  }
  return byteCount
}

private func checkedAdd(_ lhs: Int, _ rhs: Int) throws -> Int {
  let (result, overflow) = lhs.addingReportingOverflow(rhs)
  guard !overflow else {
    throw VGPURuntimeArrayLayoutError.arithmeticOverflow
  }
  return result
}
