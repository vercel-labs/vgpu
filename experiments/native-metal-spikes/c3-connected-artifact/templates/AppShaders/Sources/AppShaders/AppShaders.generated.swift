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

private enum AppShadersGeneratedError: Error, Sendable {
  case byteCount
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

public struct Particle: Equatable, Sendable {
  public var mass: UInt32
  public var id: UInt32

  public init(mass: UInt32, id: UInt32) {
    self.mass = mass
    self.id = id
  }
}

public enum Values: VGPURuntimeArrayLayout {
  public struct Prefix: Equatable, Sendable {
    public var prefix: UInt32

    public init(prefix: UInt32) {
      self.prefix = prefix
    }
  }

  public typealias Element = Particle
  public typealias Storage = VGPURuntimeStorage<Values>
  public typealias Binding = VGPURuntimeStorageBinding<Values>

  public static let _vgpuRuntimeArrayLayout = _VGPURuntimeArrayLayoutDescriptor(
    tailOffset: 4,
    elementStride: 12,
    minimumBindingSize: 16
  )

  public static func _vgpuPackPrefix(_ value: Prefix) throws -> Data {
    UInt32._vgpuPack(value.prefix)
  }

  public static func _vgpuUnpackPrefix(_ bytes: Data) throws -> Prefix {
    Prefix(prefix: try UInt32._vgpuUnpack(bytes))
  }

  public static func _vgpuPackElement(_ value: Particle) throws -> Data {
    var bytes = Data(repeating: 0, count: 12)
    bytes.replaceSubrange(0..<4, with: UInt32._vgpuPack(value.mass))
    bytes.replaceSubrange(8..<12, with: UInt32._vgpuPack(value.id))
    return bytes
  }

  public static func _vgpuUnpackElement(_ bytes: Data) throws -> Particle {
    guard bytes.count == 12 else {
      throw AppShadersGeneratedError.byteCount
    }
    return Particle(
      mass: try UInt32._vgpuUnpack(bytes.subdata(in: 0..<4)),
      id: try UInt32._vgpuUnpack(bytes.subdata(in: 8..<12))
    )
  }
}

public enum __PROGRAM_SWIFT_NAME__: VGPUComputeProgram {
  public struct Bindings: VGPUBindingSet {
    public var values: VGPURuntimeStorageBinding<Values>
    public var output: VGPUStorage<UInt32>

    public init(values: VGPURuntimeStorageBinding<Values>, output: VGPUStorage<UInt32>) {
      self.values = values
      self.output = output
    }

    public func _vgpuEncodeBindings(to encoder: inout _VGPUBindingEncoder) throws {
      try encoder.storage(values, at: 0)
      try encoder.storage(output, at: 1)
    }
  }

  private static let artifact = _VGPUProgramArtifact(ArtifactWitness.self)

  public static let _vgpuProgramDescriptor = _VGPUProgramDescriptor(
    artifactID: "assembly-runtime-sized-storage",
    programID: "AssemblyRuntimeSizedStorage",
    entryPointID: "compute_main",
    bindings: [
      _VGPULogicalBindingDescriptor(ordinal: 0, access: .read, runtimeSized: true),
      _VGPULogicalBindingDescriptor(ordinal: 1, access: .readWrite, runtimeSized: false),
    ],
    workgroupSize: (1, 1, 1),
    artifact: artifact
  )
}
