import Foundation
import VGPUABI

enum GeneratedFixtureError: Error, Equatable, CustomStringConvertible, Sendable {
  case byteCount(expected: Int, actual: Int)

  var description: String {
    switch self {
    case .byteCount(let expected, let actual):
      "Generated fixture expected \(expected) bytes, received \(actual)."
    }
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
    var bytes = Data(repeating: 0, count: 4)
    writeUInt32(value.prefix, to: &bytes, at: 0)
    return bytes
  }

  public static func _vgpuUnpackPrefix(_ bytes: Data) throws -> Prefix {
    try requireByteCount(bytes, 4)
    return Prefix(prefix: readUInt32(bytes, at: 0))
  }

  public static func _vgpuPackElement(_ value: Particle) throws -> Data {
    var bytes = Data(repeating: 0, count: 12)
    writeUInt32(value.mass, to: &bytes, at: 0)
    writeUInt32(value.id, to: &bytes, at: 8)
    return bytes
  }

  public static func _vgpuUnpackElement(_ bytes: Data) throws -> Particle {
    try requireByteCount(bytes, 12)
    return Particle(
      mass: readUInt32(bytes, at: 0),
      id: readUInt32(bytes, at: 8)
    )
  }
}

private func requireByteCount(_ bytes: Data, _ expected: Int) throws {
  guard bytes.count == expected else {
    throw GeneratedFixtureError.byteCount(expected: expected, actual: bytes.count)
  }
}

private func writeUInt32(_ value: UInt32, to bytes: inout Data, at offset: Int) {
  var littleEndian = value.littleEndian
  Swift.withUnsafeBytes(of: &littleEndian) { source in
    bytes.replaceSubrange(offset..<(offset + 4), with: source)
  }
}

private func readUInt32(_ data: Data, at offset: Int) -> UInt32 {
  let bytes = [UInt8](data)
  let value =
    UInt32(bytes[offset])
    | (UInt32(bytes[offset + 1]) << 8)
    | (UInt32(bytes[offset + 2]) << 16)
    | (UInt32(bytes[offset + 3]) << 24)
  return UInt32(littleEndian: value)
}
