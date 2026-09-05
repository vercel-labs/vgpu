import Foundation
import VGPUABI

enum GeneratedFixtureError: Error, Sendable {
  case byteCount
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

    public init(prefix: UInt32) { self.prefix = prefix }
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
    guard bytes.count == 12 else { throw GeneratedFixtureError.byteCount }
    return Particle(
      mass: try UInt32._vgpuUnpack(bytes.subdata(in: 0..<4)),
      id: try UInt32._vgpuUnpack(bytes.subdata(in: 8..<12))
    )
  }
}

public enum InspectValues: VGPUComputeProgram {
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

  public static let _vgpuProgramDescriptor = _VGPUProgramDescriptor(
    artifactID: "assembly-runtime-sized-storage",
    programID: "AssemblyRuntimeSizedStorage",
    entryPointID: "inspect-values",
    bindings: [
      _VGPULogicalBindingDescriptor(ordinal: 0, access: .read, runtimeSized: true),
      _VGPULogicalBindingDescriptor(ordinal: 1, access: .readWrite, runtimeSized: false),
    ],
    workgroupSize: (1, 1, 1)
  )
}
