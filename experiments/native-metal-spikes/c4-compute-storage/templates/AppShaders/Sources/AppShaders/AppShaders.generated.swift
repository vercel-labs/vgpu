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

public enum AdvanceState: VGPUComputeProgram {
  public struct Bindings: VGPUBindingSet {
    public var source: VGPUStorage<UInt32>
    public var mask: VGPUStorage<UInt32>
    public var destination: VGPUStorage<UInt32>
    public var audit: VGPUStorage<UInt32>

    public init(
      source: VGPUStorage<UInt32>,
      mask: VGPUStorage<UInt32>,
      destination: VGPUStorage<UInt32>,
      audit: VGPUStorage<UInt32>
    ) {
      self.source = source
      self.mask = mask
      self.destination = destination
      self.audit = audit
    }

    public func _vgpuEncodeBindings(to encoder: inout _VGPUBindingEncoder) throws {
      try encoder.runtimeSizedStorage(source, at: 0)
      try encoder.runtimeSizedStorage(mask, at: 1)
      try encoder.runtimeSizedStorage(destination, at: 2)
      try encoder.runtimeSizedStorage(audit, at: 3)
    }
  }

  private static let artifact = _VGPUProgramArtifact(ArtifactWitness.self)

  public static let _vgpuProgramDescriptor = _VGPUProgramDescriptor(
    artifactID: "c4-compute-storage",
    programID: "AdvanceState",
    entryPointID: "advance",
    bindings: [
      _VGPULogicalBindingDescriptor(ordinal: 0, access: .read, runtimeSized: true),
      _VGPULogicalBindingDescriptor(ordinal: 1, access: .read, runtimeSized: true),
      _VGPULogicalBindingDescriptor(ordinal: 2, access: .readWrite, runtimeSized: true),
      _VGPULogicalBindingDescriptor(ordinal: 3, access: .readWrite, runtimeSized: true),
    ],
    workgroupSize: (2, 1, 1),
    artifact: artifact
  )
}

public enum MixState: VGPUComputeProgram {
  public struct Bindings: VGPUBindingSet {
    public var source: VGPUStorage<UInt32>
    public var mask: VGPUStorage<UInt32>
    public var destination: VGPUStorage<UInt32>
    public var audit: VGPUStorage<UInt32>

    public init(
      source: VGPUStorage<UInt32>,
      mask: VGPUStorage<UInt32>,
      destination: VGPUStorage<UInt32>,
      audit: VGPUStorage<UInt32>
    ) {
      self.source = source
      self.mask = mask
      self.destination = destination
      self.audit = audit
    }

    public func _vgpuEncodeBindings(to encoder: inout _VGPUBindingEncoder) throws {
      try encoder.runtimeSizedStorage(source, at: 0)
      try encoder.runtimeSizedStorage(mask, at: 1)
      try encoder.runtimeSizedStorage(destination, at: 2)
      try encoder.runtimeSizedStorage(audit, at: 3)
    }
  }

  private static let artifact = _VGPUProgramArtifact(ArtifactWitness.self)

  public static let _vgpuProgramDescriptor = _VGPUProgramDescriptor(
    artifactID: "c4-compute-storage",
    programID: "MixState",
    entryPointID: "mix",
    bindings: [
      _VGPULogicalBindingDescriptor(ordinal: 0, access: .read, runtimeSized: true),
      _VGPULogicalBindingDescriptor(ordinal: 1, access: .read, runtimeSized: true),
      _VGPULogicalBindingDescriptor(ordinal: 2, access: .readWrite, runtimeSized: true),
      _VGPULogicalBindingDescriptor(ordinal: 3, access: .readWrite, runtimeSized: true),
    ],
    workgroupSize: (1, 2, 1),
    artifact: artifact
  )
}
