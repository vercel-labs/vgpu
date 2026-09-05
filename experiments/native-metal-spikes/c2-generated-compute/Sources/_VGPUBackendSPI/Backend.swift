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
  package let contextIdentity: UInt64
  package let allocationIdentity: UInt64
  package let generation: UInt64
  package let offset: Int
  package let backingByteCount: Int
  package let access: VGPUStorageAccess

  package init(
    handle: VGPUBackendStorageHandle,
    contextIdentity: UInt64,
    allocationIdentity: UInt64,
    generation: UInt64,
    offset: Int,
    backingByteCount: Int,
    access: VGPUStorageAccess
  ) {
    self.handle = handle
    self.contextIdentity = contextIdentity
    self.allocationIdentity = allocationIdentity
    self.generation = generation
    self.offset = offset
    self.backingByteCount = backingByteCount
    self.access = access
  }

  package var abiSnapshot: _VGPUStorageSnapshot {
    _VGPUStorageSnapshot(
      handle: handle.rawValue,
      contextIdentity: contextIdentity,
      allocationIdentity: allocationIdentity,
      generation: generation,
      offset: offset,
      backingByteCount: backingByteCount,
      access: access
    )
  }
}

package struct VGPUBackendComputeBinding: Sendable {
  package let ordinal: Int
  package let snapshot: VGPUBackendStorageSnapshot
  package let boundByteCount: Int
  package let elementCount: Int?

  package init(
    ordinal: Int,
    snapshot: VGPUBackendStorageSnapshot,
    boundByteCount: Int,
    elementCount: Int?
  ) {
    self.ordinal = ordinal
    self.snapshot = snapshot
    self.boundByteCount = boundByteCount
    self.elementCount = elementCount
  }
}

package struct VGPUBackendProgramHandle: Hashable, Sendable {
  package let rawValue: UInt64

  package init(rawValue: UInt64) { self.rawValue = rawValue }
}

package struct VGPUBackendComputeCommand: Sendable {
  package let programHandle: VGPUBackendProgramHandle
  package let program: _VGPUProgramDescriptor
  package let bindings: [VGPUBackendComputeBinding]
  package let threadgroups: (x: Int, y: Int, z: Int)

  package init(
    programHandle: VGPUBackendProgramHandle,
    program: _VGPUProgramDescriptor,
    bindings: [VGPUBackendComputeBinding],
    threadgroups: (x: Int, y: Int, z: Int)
  ) {
    self.programHandle = programHandle
    self.program = program
    self.bindings = bindings
    self.threadgroups = threadgroups
  }
}

package protocol VGPUBackendExecution: Sendable {
  func wait() async throws
}

package protocol VGPUCoreBackend: AnyObject, Sendable {
  var contextIdentity: UInt64 { get }
}

package protocol VGPUResourceBackend: VGPUCoreBackend {
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

  func releaseStorage(handle: VGPUBackendStorageHandle)

}

package protocol VGPUComputeBackend: VGPUCoreBackend {
  func prepareCompute(
    _ program: _VGPUProgramDescriptor
  ) throws -> VGPUBackendProgramHandle

  func submitCompute(
    _ command: VGPUBackendComputeCommand
  ) throws -> any VGPUBackendExecution
}
