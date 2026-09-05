import Foundation
import VGPUABI
import VGPUCore
import _VGPUBackendSPI

package enum VGPUResourceError: Error, Equatable, CustomStringConvertible, Sendable {
  case invalidCount(Int)
  case initialCountExceedsCapacity(capacity: Int, actual: Int)
  case elementCountExceedsCapacity(capacity: Int, actual: Int)
  case invalidRange
  case invalidPackedByteCount(expected: Int, actual: Int)
  case incompatibleBackendSnapshot
  case disposed

  package var description: String {
    switch self {
    case .invalidCount(let count): "Resource count must be positive; received \(count)."
    case .initialCountExceedsCapacity(let capacity, let actual):
      "Initial count \(actual) exceeds capacity \(capacity)."
    case .elementCountExceedsCapacity(let capacity, let actual):
      "Binding count \(actual) exceeds capacity \(capacity)."
    case .invalidRange: "The resource operation range is invalid."
    case .invalidPackedByteCount(let expected, let actual):
      "Packed value has \(actual) bytes; expected \(expected)."
    case .incompatibleBackendSnapshot: "The storage backend returned an incompatible snapshot."
    case .disposed: "The storage resource is disposed."
    }
  }
}

private final class StorageLease: _VGPUResourceLease, @unchecked Sendable {
  private let lock = NSLock()
  private var lifetime: StorageLifetime?
  private var released = false

  init(lifetime: StorageLifetime) {
    self.lifetime = lifetime
  }

  func release() {
    lock.lock()
    guard !released else {
      lock.unlock()
      return
    }
    released = true
    let current = lifetime
    lifetime = nil
    lock.unlock()
    current?.releaseLease()
  }

  deinit {
    release()
  }
}

private final class StorageLifetime: @unchecked Sendable {
  private let lock = NSLock()
  private let releaseGeneration: @Sendable () -> Void
  private var ownerClosed = false
  private var leaseCount = 0
  private var generationReleased = false

  init(releaseGeneration: @escaping @Sendable () -> Void) {
    self.releaseGeneration = releaseGeneration
  }

  func acquire() throws -> any _VGPUResourceLease {
    lock.lock()
    guard !ownerClosed else {
      lock.unlock()
      throw VGPUResourceError.disposed
    }
    leaseCount += 1
    lock.unlock()
    return StorageLease(lifetime: self)
  }

  func close() {
    let shouldRelease: Bool
    lock.lock()
    ownerClosed = true
    shouldRelease = leaseCount == 0 && !generationReleased
    if shouldRelease { generationReleased = true }
    lock.unlock()
    if shouldRelease { releaseGeneration() }
  }

  func releaseLease() {
    let shouldRelease: Bool
    lock.lock()
    precondition(leaseCount > 0, "storage lease underflow")
    leaseCount -= 1
    shouldRelease = ownerClosed && leaseCount == 0 && !generationReleased
    if shouldRelease { generationReleased = true }
    lock.unlock()
    if shouldRelease { releaseGeneration() }
  }

  var isClosed: Bool {
    lock.lock()
    defer { lock.unlock() }
    return ownerClosed
  }

  deinit {
    close()
  }
}

private final class StorageBox: _VGPUStorageBox, _VGPUContextChild, @unchecked Sendable {
  private let lock = NSLock()
  private let gpu: VGPU
  private let backend: any VGPUResourceBackend
  private let handle: VGPUBackendStorageHandle
  private let logicalByteCount: Int
  private let lifetime: StorageLifetime
  private var disposed = false

  init(
    gpu: VGPU,
    backend: any VGPUResourceBackend,
    handle: VGPUBackendStorageHandle,
    logicalByteCount: Int
  ) {
    self.gpu = gpu
    self.backend = backend
    self.handle = handle
    self.logicalByteCount = logicalByteCount
    self.lifetime = StorageLifetime {
      backend.releaseStorage(handle: handle)
    }
  }

  var isDisposed: Bool {
    lock.lock()
    defer { lock.unlock() }
    return disposed
  }

  func replaceBytes(in range: Range<Int>, with bytes: Data) throws {
    try gpu.withOpenAccess {
      let current = try checkedHandle(range: range)
      guard range.count == bytes.count else { throw VGPUResourceError.invalidRange }
      try backend.replaceStorageBytes(handle: current, range: range, bytes: bytes)
    }
  }

  func readBytes(in range: Range<Int>) async throws -> Data {
    let registration = try gpu.withOpenAccess { () -> (VGPUBackendStorageHandle, VGPUWorkTicket) in
      let current = try checkedHandle(range: range)
      let lease = try lifetime.acquire()
      return (current, gpu.workLedger.register(leases: [lease]))
    }
    do {
      let bytes = try await backend.readStorageBytes(handle: registration.0, range: range)
      await registration.1.finish()
      return bytes
    } catch {
      await registration.1.finish()
      throw mapBackendError(error, operation: "resource.read")
    }
  }

  func validate(
    boundByteCount: Int,
    requiredAccess: VGPUStorageAccess,
    contextIdentity: UInt64?
  ) throws {
    try gpu.withOpenAccess {
      let snapshot = try checkedSnapshot(boundByteCount: boundByteCount)
      guard snapshot.access.satisfies(requiredAccess) else {
        throw _VGPUABIError.incompatibleAccess
      }
      if let contextIdentity, snapshot.contextIdentity != contextIdentity {
        throw VGPUError(
          code: .contextMismatch,
          message: "A storage resource belongs to another VGPU context."
        )
      }
    }
  }

  func prepare(
    boundByteCount: Int,
    elementCount: Int?,
    requiredAccess: VGPUStorageAccess
  ) throws -> _VGPUPreparedStorage {
    try gpu.withOpenAccess {
      let snapshot = try checkedSnapshot(boundByteCount: boundByteCount)
      guard snapshot.access.satisfies(requiredAccess) else {
        throw _VGPUABIError.incompatibleAccess
      }
      let lease = try lifetime.acquire()
      return _VGPUPreparedStorage(
        snapshot: snapshot.abiSnapshot,
        boundByteCount: boundByteCount,
        elementCount: elementCount,
        lease: lease
      )
    }
  }

  func dispose() throws {
    try gpu.withAccess {
      closeFromContext()
    }
  }

  func closeFromContext() {
    lock.lock()
    let shouldClose = !disposed
    disposed = true
    lock.unlock()
    if shouldClose { lifetime.close() }
  }

  private func checkedHandle(range: Range<Int>) throws -> VGPUBackendStorageHandle {
    lock.lock()
    defer { lock.unlock() }
    guard !disposed else { throw VGPUResourceError.disposed }
    guard range.lowerBound >= 0, range.upperBound <= logicalByteCount else {
      throw VGPUResourceError.invalidRange
    }
    return handle
  }

  private func checkedSnapshot(boundByteCount: Int) throws -> VGPUBackendStorageSnapshot {
    lock.lock()
    guard !disposed, boundByteCount > 0, boundByteCount <= logicalByteCount else {
      lock.unlock()
      throw disposed ? VGPUResourceError.disposed : VGPUResourceError.invalidRange
    }
    lock.unlock()
    let snapshot = try backend.storageSnapshot(handle: handle)
    let (logicalEnd, overflow) = snapshot.offset.addingReportingOverflow(logicalByteCount)
    guard
      !overflow,
      snapshot.contextIdentity == backend.contextIdentity,
      snapshot.offset >= 0,
      logicalEnd <= snapshot.backingByteCount
    else {
      throw VGPUResourceError.incompatibleBackendSnapshot
    }
    return snapshot
  }
}

public final class VGPUPingPongStorage<Element: VGPUScalar> {
  public private(set) var read: VGPUStorage<Element>
  public private(set) var write: VGPUStorage<Element>

  fileprivate init(read: VGPUStorage<Element>, write: VGPUStorage<Element>) {
    self.read = read
    self.write = write
  }

  public func swap() {
    (read, write) = (write, read)
  }
}

@available(*, unavailable)
extension VGPUPingPongStorage: Sendable {}

extension VGPU {
  public func pingPongStorage<Element: VGPUScalar>(
    _ element: Element.Type,
    count: Int,
    initialValues: [Element] = []
  ) throws -> VGPUPingPongStorage<Element> {
    try withOpenAccess {
      let read = try storage(
        element,
        count: count,
        access: .readWrite,
        initialValues: initialValues
      )
      do {
        let write = try storage(element, count: count, access: .readWrite)
        return VGPUPingPongStorage(read: read, write: write)
      } catch {
        try? read.dispose()
        throw error
      }
    }
  }

  public func storage<Layout: VGPURuntimeArrayLayout>(
    _ layout: Layout.Type,
    prefix: Layout.Prefix,
    capacity: Int,
    access: VGPUStorageAccess = .readWrite,
    initialElements: [Layout.Element] = []
  ) throws -> VGPURuntimeStorage<Layout> {
    try withOpenAccess {
      guard let backend = backend as? any VGPUResourceBackend else {
        throw VGPUError(
          code: .backendOperationFailed,
          message: "The Resources backend capability is unavailable."
        )
      }
      guard capacity > 0 else { throw VGPUResourceError.invalidCount(capacity) }
      guard initialElements.count <= capacity else {
        throw VGPUResourceError.initialCountExceedsCapacity(
          capacity: capacity,
          actual: initialElements.count
        )
      }
      let descriptor = Layout._vgpuRuntimeArrayLayout
      let byteCount = try descriptor.rangeBytes(exactElementCount: capacity)
      let prefixBytes = try Layout._vgpuPackPrefix(prefix)
      guard prefixBytes.count == descriptor.tailOffset else {
        throw VGPUResourceError.invalidPackedByteCount(
          expected: descriptor.tailOffset,
          actual: prefixBytes.count
        )
      }
      var bytes = Data(repeating: 0, count: byteCount)
      bytes.replaceSubrange(0..<descriptor.tailOffset, with: prefixBytes)
      for (index, element) in initialElements.enumerated() {
        let packed = try Layout._vgpuPackElement(element)
        guard packed.count == descriptor.elementStride else {
          throw VGPUResourceError.invalidPackedByteCount(
            expected: descriptor.elementStride,
            actual: packed.count
          )
        }
        let start = descriptor.tailOffset + index * descriptor.elementStride
        bytes.replaceSubrange(start..<(start + descriptor.elementStride), with: packed)
      }
      let handle = try backend.allocateStorage(initialBytes: bytes, access: access)
      let box = StorageBox(
        gpu: self,
        backend: backend,
        handle: handle,
        logicalByteCount: byteCount
      )
      try registerChild(box)
      return VGPURuntimeStorage(
        capacity: capacity,
        sizeInBytes: byteCount,
        access: access,
        box: box
      )
    }
  }

  public func storage<Element: VGPUScalar>(
    _ element: Element.Type,
    count: Int,
    access: VGPUStorageAccess = .readWrite,
    initialValues: [Element] = []
  ) throws -> VGPUStorage<Element> {
    try withOpenAccess {
      guard let backend = backend as? any VGPUResourceBackend else {
        throw VGPUError(
          code: .backendOperationFailed,
          message: "The Resources backend capability is unavailable."
        )
      }
      guard count > 0 else { throw VGPUResourceError.invalidCount(count) }
      guard initialValues.count <= count else {
        throw VGPUResourceError.initialCountExceedsCapacity(
          capacity: count,
          actual: initialValues.count
        )
      }
      let (byteCount, overflow) = Element._vgpuStride.multipliedReportingOverflow(by: count)
      guard !overflow else { throw VGPUResourceError.invalidRange }
      var bytes = Data(repeating: 0, count: byteCount)
      for (index, value) in initialValues.enumerated() {
        let packed = Element._vgpuPack(value)
        guard packed.count == Element._vgpuStride else {
          throw VGPUResourceError.invalidPackedByteCount(
            expected: Element._vgpuStride,
            actual: packed.count
          )
        }
        let start = index * Element._vgpuStride
        bytes.replaceSubrange(start..<(start + Element._vgpuStride), with: packed)
      }
      let handle = try backend.allocateStorage(initialBytes: bytes, access: access)
      let box = StorageBox(
        gpu: self,
        backend: backend,
        handle: handle,
        logicalByteCount: byteCount
      )
      try registerChild(box)
      return VGPUStorage(
        count: count,
        sizeInBytes: byteCount,
        access: access,
        box: box
      )
    }
  }
}

extension VGPURuntimeStorage {
  public func binding(elementCount: Int) throws -> VGPURuntimeStorageBinding<Layout> {
    guard elementCount > 0, elementCount <= capacity else {
      throw VGPUResourceError.elementCountExceedsCapacity(
        capacity: capacity,
        actual: elementCount
      )
    }
    let sizeInBytes = try Layout._vgpuRuntimeArrayLayout.rangeBytes(
      exactElementCount: elementCount
    )
    try _box.validate(
      boundByteCount: sizeInBytes,
      requiredAccess: access,
      contextIdentity: nil
    )
    return VGPURuntimeStorageBinding(
      storage: self,
      elementCount: elementCount,
      sizeInBytes: sizeInBytes
    )
  }

  public func readElements(
    range: Range<Int>,
    isolation: isolated (any Actor)? = #isolation
  ) async throws -> [Layout.Element] {
    guard range.lowerBound >= 0, range.upperBound <= capacity else {
      throw VGPUResourceError.invalidRange
    }
    let descriptor = Layout._vgpuRuntimeArrayLayout
    let start = descriptor.tailOffset + range.lowerBound * descriptor.elementStride
    let end = descriptor.tailOffset + range.upperBound * descriptor.elementStride
    let bytes = try await _box.readBytes(in: start..<end)
    return try (0..<range.count).map { index in
      let offset = index * descriptor.elementStride
      return try Layout._vgpuUnpackElement(
        bytes.subdata(in: offset..<(offset + descriptor.elementStride))
      )
    }
  }

  public func dispose() throws {
    try _box.dispose()
  }
}

extension VGPUStorage {
  public func read(
    isolation: isolated (any Actor)? = #isolation
  ) async throws -> [Element] {
    let bytes = try await _box.readBytes(in: 0..<sizeInBytes)
    return try (0..<count).map { index in
      let start = index * Element._vgpuStride
      return try Element._vgpuUnpack(bytes.subdata(in: start..<(start + Element._vgpuStride)))
    }
  }

  public func dispose() throws {
    try _box.dispose()
  }
}
