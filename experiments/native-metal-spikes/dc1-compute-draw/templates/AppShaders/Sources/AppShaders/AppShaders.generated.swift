import Foundation
import VGPUABI

private enum AppShadersResourceError: Error {
  case missing(String)
}

private enum AppShadersResources {
  static func descriptorData() throws -> Data {
    try data(named: "AppShaders.artifact", extension: "json")
  }

  static func libraryData() throws -> Data {
    try data(named: "AppShaders", extension: "metallib")
  }

  private static func data(named name: String, extension fileExtension: String) throws -> Data {
    guard let url = Bundle.module.url(forResource: name, withExtension: fileExtension) else {
      throw AppShadersResourceError.missing("\(name).\(fileExtension)")
    }
    return try Data(contentsOf: url)
  }
}

private enum ArtifactWitness: _VGPUProgramArtifactWitness {
  static let _vgpuDescriptorSHA256 = "__DESCRIPTOR_SHA256__"
  static let _vgpuLibrarySHA256 = "__LIBRARY_SHA256__"

  static func _vgpuLoadDescriptor() throws -> Data {
    try AppShadersResources.descriptorData()
  }

  static func _vgpuLoadLibrary() throws -> Data {
    try AppShadersResources.libraryData()
  }
}

private let sharedArtifact = _VGPUProgramArtifact(ArtifactWitness.self)

public enum ConsumePacket: VGPUDrawProgram {
  public static let _vgpuDrawProgramDescriptor = _VGPUDrawProgramDescriptor(
    artifactID: "dc1-compute-draw",
    programID: "ConsumePacket",
    vertexEntryPointID: "vertexMain",
    fragmentEntryPointID: "fragmentMain",
    artifact: sharedArtifact
  )
}

public enum ProducePacket: VGPUComputeProgram {
  public struct Bindings: VGPUBindingSet {
    public var produced: VGPUStorage<UInt32>

    public init(produced: VGPUStorage<UInt32>) {
      self.produced = produced
    }

    public func _vgpuEncodeBindings(to encoder: inout _VGPUBindingEncoder) throws {
      try encoder.storage(produced, at: 0)
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
    artifact: sharedArtifact
  )
}
