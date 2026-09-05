import VGPUABI

package struct VGPUBackendTargetHandle: Hashable, Sendable {
  package let rawValue: UInt64

  package init(rawValue: UInt64) { self.rawValue = rawValue }
}

package struct VGPUBackendDrawProgramHandle: Hashable, Sendable {
  package let rawValue: UInt64

  package init(rawValue: UInt64) { self.rawValue = rawValue }
}

package struct VGPUBackendIndirectDraw: Sendable {
  package let program: VGPUBackendDrawProgramHandle
  package let directVertexCount: Int
  package let snapshot: VGPUBackendStorageSnapshot
  package let viewRange: Range<Int>
  package let consumerByteOffset: Int
  package let physicalByteOffset: Int

  package init(
    program: VGPUBackendDrawProgramHandle,
    directVertexCount: Int,
    snapshot: VGPUBackendStorageSnapshot,
    viewRange: Range<Int>,
    consumerByteOffset: Int,
    physicalByteOffset: Int
  ) {
    self.program = program
    self.directVertexCount = directVertexCount
    self.snapshot = snapshot
    self.viewRange = viewRange
    self.consumerByteOffset = consumerByteOffset
    self.physicalByteOffset = physicalByteOffset
  }
}

package struct VGPUBackendFrameCommand: Sendable {
  package let target: VGPUBackendTargetHandle
  package let draws: [VGPUBackendIndirectDraw]

  package init(target: VGPUBackendTargetHandle, draws: [VGPUBackendIndirectDraw]) {
    self.target = target
    self.draws = draws
  }
}

package protocol VGPURenderBackend: VGPUCoreBackend {
  func createOffscreenTarget(width: Int, height: Int) throws -> VGPUBackendTargetHandle

  func prepareDraw(
    _ descriptor: _VGPUDrawProgramDescriptor
  ) throws -> VGPUBackendDrawProgramHandle

  func submitFrame(
    _ commands: [VGPUBackendFrameCommand]
  ) throws -> any VGPUBackendExecution
}
