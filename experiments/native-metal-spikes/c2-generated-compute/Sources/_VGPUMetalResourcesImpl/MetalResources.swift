import Foundation
import Metal
import VGPUABI
import _VGPUBackendSPI
import _VGPUMetalCoreImpl

package enum MetalResourceBackendError: Error, Sendable {
  case allocationFailed
  case missingAllocation
  case invalidRange
}

package final class MetalResourceBackend: VGPUResourceBackend, @unchecked Sendable {
  private struct Allocation {
    let buffer: MTLBuffer
    let access: VGPUStorageAccess
    let identity: UInt64
    let generation: UInt64
  }

  package let core: MetalCore
  private let lock = NSLock()
  private var nextHandle: UInt64 = 1
  private var allocations: [VGPUBackendStorageHandle: Allocation] = [:]

  package init(core: MetalCore) { self.core = core }

  package var contextIdentity: UInt64 { core.contextIdentity }

  package func allocateStorage(
    initialBytes: Data,
    access: VGPUStorageAccess
  ) throws -> VGPUBackendStorageHandle {
    guard !initialBytes.isEmpty else { throw MetalResourceBackendError.allocationFailed }
    let buffer = initialBytes.withUnsafeBytes { bytes -> MTLBuffer? in
      guard let baseAddress = bytes.baseAddress else { return nil }
      return core.device.makeBuffer(
        bytes: baseAddress,
        length: bytes.count,
        options: [.storageModeShared]
      )
    }
    guard let buffer else { throw MetalResourceBackendError.allocationFailed }
    lock.lock()
    let handle = VGPUBackendStorageHandle(rawValue: nextHandle)
    nextHandle += 1
    allocations[handle] = Allocation(
      buffer: buffer,
      access: access,
      identity: handle.rawValue,
      generation: 1
    )
    lock.unlock()
    return handle
  }

  package func replaceStorageBytes(
    handle: VGPUBackendStorageHandle,
    range: Range<Int>,
    bytes: Data
  ) throws {
    let buffer = try checkedBuffer(handle: handle, range: range)
    guard range.count == bytes.count else { throw MetalResourceBackendError.invalidRange }
    bytes.withUnsafeBytes { source in
      if let address = source.baseAddress {
        memcpy(buffer.contents().advanced(by: range.lowerBound), address, source.count)
      }
    }
  }

  package func readStorageBytes(
    handle: VGPUBackendStorageHandle,
    range: Range<Int>
  ) async throws -> Data {
    let buffer = try checkedBuffer(handle: handle, range: range)
    return Data(
      bytes: buffer.contents().advanced(by: range.lowerBound),
      count: range.count
    )
  }

  package func storageSnapshot(
    handle: VGPUBackendStorageHandle
  ) throws -> VGPUBackendStorageSnapshot {
    lock.lock()
    defer { lock.unlock() }
    guard let allocation = allocations[handle] else {
      throw MetalResourceBackendError.missingAllocation
    }
    return VGPUBackendStorageSnapshot(
      handle: handle,
      contextIdentity: contextIdentity,
      allocationIdentity: allocation.identity,
      generation: allocation.generation,
      offset: 0,
      backingByteCount: allocation.buffer.length,
      access: allocation.access
    )
  }

  package func releaseStorage(handle: VGPUBackendStorageHandle) {
    lock.lock()
    allocations.removeValue(forKey: handle)
    lock.unlock()
  }

  package func buffer(for snapshot: VGPUBackendStorageSnapshot) throws -> MTLBuffer {
    lock.lock()
    defer { lock.unlock() }
    guard
      snapshot.contextIdentity == contextIdentity,
      let allocation = allocations[snapshot.handle],
      allocation.identity == snapshot.allocationIdentity,
      allocation.generation == snapshot.generation
    else {
      throw MetalResourceBackendError.missingAllocation
    }
    return allocation.buffer
  }

  package func contains(allocationIdentity: UInt64) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    return allocations.values.contains { $0.identity == allocationIdentity }
  }

  private func checkedBuffer(
    handle: VGPUBackendStorageHandle,
    range: Range<Int>
  ) throws -> MTLBuffer {
    lock.lock()
    defer { lock.unlock() }
    guard let allocation = allocations[handle] else {
      throw MetalResourceBackendError.missingAllocation
    }
    guard range.lowerBound >= 0, range.upperBound <= allocation.buffer.length else {
      throw MetalResourceBackendError.invalidRange
    }
    return allocation.buffer
  }
}

extension MetalBackend {
  package var resourceBackend: MetalResourceBackend {
    capabilityState(MetalResourceBackend.self) {
      MetalResourceBackend(core: core)
    }
  }
}

extension MetalBackend: VGPUResourceBackend {
  package func allocateStorage(
    initialBytes: Data,
    access: VGPUStorageAccess
  ) throws -> VGPUBackendStorageHandle {
    try resourceBackend.allocateStorage(initialBytes: initialBytes, access: access)
  }

  package func replaceStorageBytes(
    handle: VGPUBackendStorageHandle,
    range: Range<Int>,
    bytes: Data
  ) throws {
    try resourceBackend.replaceStorageBytes(handle: handle, range: range, bytes: bytes)
  }

  package func readStorageBytes(
    handle: VGPUBackendStorageHandle,
    range: Range<Int>
  ) async throws -> Data {
    try await resourceBackend.readStorageBytes(handle: handle, range: range)
  }

  package func storageSnapshot(
    handle: VGPUBackendStorageHandle
  ) throws -> VGPUBackendStorageSnapshot {
    try resourceBackend.storageSnapshot(handle: handle)
  }

  package func releaseStorage(handle: VGPUBackendStorageHandle) {
    resourceBackend.releaseStorage(handle: handle)
  }
}
