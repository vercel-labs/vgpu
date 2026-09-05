import Foundation
import VGPUABI

package struct VGPUBackendStorageHandle: Hashable, Sendable {
  package let rawValue: UInt64

  package init(rawValue: UInt64) {
    self.rawValue = rawValue
  }
}

package struct VGPUBackendStorageSnapshot: Equatable, Sendable {
  package let handle: VGPUBackendStorageHandle
  package let identity: UInt64
  package let generation: UInt64
  package let offset: Int
  package let backingByteCount: Int
  package let access: VGPUStorageAccess

  package init(
    handle: VGPUBackendStorageHandle,
    identity: UInt64,
    generation: UInt64,
    offset: Int,
    backingByteCount: Int,
    access: VGPUStorageAccess
  ) {
    self.handle = handle
    self.identity = identity
    self.generation = generation
    self.offset = offset
    self.backingByteCount = backingByteCount
    self.access = access
  }
}

package protocol VGPUStorageBackend: AnyObject, Sendable {
  func allocateStorage(
    initialBytes: Data,
    access: VGPUStorageAccess
  ) throws -> VGPUBackendStorageHandle

  func replaceStorageBytes(
    handle: VGPUBackendStorageHandle,
    range: Range<Int>,
    bytes: Data
  ) throws

  func readStorageBytes(
    handle: VGPUBackendStorageHandle,
    range: Range<Int>
  ) async throws -> Data

  func storageSnapshot(
    handle: VGPUBackendStorageHandle
  ) throws -> VGPUBackendStorageSnapshot

  func disposeStorage(handle: VGPUBackendStorageHandle)
}

package struct VGPUPreparedRuntimeStorageBinding: Equatable, Sendable {
  package let allocation: VGPUBackendStorageSnapshot
  package let boundByteCount: Int
  package let elementCount: Int

  package init(
    allocation: VGPUBackendStorageSnapshot,
    boundByteCount: Int,
    elementCount: Int
  ) {
    self.allocation = allocation
    self.boundByteCount = boundByteCount
    self.elementCount = elementCount
  }
}
