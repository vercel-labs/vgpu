import Foundation
import VGPUABI

private enum DC1ArtifactWitness: _VGPUProgramArtifactWitness {
  static let _vgpuDescriptorSHA256 = String(repeating: "d", count: 64)
  static let _vgpuLibrarySHA256 = String(repeating: "1", count: 64)

  static func _vgpuLoadDescriptor() throws -> Data { Data("dc1-descriptor".utf8) }
  static func _vgpuLoadLibrary() throws -> Data { Data("dc1-library".utf8) }
}

private let artifact = _VGPUProgramArtifact(DC1ArtifactWitness.self)

public enum ProducePacket: VGPUComputeProgram {
  public struct Bindings: VGPUBindingSet {
    public var output: VGPUStorage<UInt32>

    public init(output: VGPUStorage<UInt32>) {
      self.output = output
    }

    public func _vgpuEncodeBindings(to encoder: inout _VGPUBindingEncoder) throws {
      try encoder.storage(output, at: 0)
    }
  }

  public static let _vgpuProgramDescriptor = _VGPUProgramDescriptor(
    artifactID: "dc1-compute-draw",
    programID: "ProducePacket",
    entryPointID: "produce",
    bindings: [
      _VGPULogicalBindingDescriptor(ordinal: 0, access: .readWrite, runtimeSized: false)
    ],
    workgroupSize: (1, 1, 1),
    artifact: artifact
  )
}

public enum ConsumePacket: VGPUDrawProgram {
  public static let _vgpuDrawProgramDescriptor = _VGPUDrawProgramDescriptor(
    artifactID: "dc1-compute-draw",
    programID: "ConsumePacket",
    vertexEntryPointID: "vertexMain",
    fragmentEntryPointID: "fragmentMain",
    artifact: artifact
  )
}
