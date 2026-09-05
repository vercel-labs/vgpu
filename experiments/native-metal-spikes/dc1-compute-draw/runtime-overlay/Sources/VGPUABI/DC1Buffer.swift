import Foundation

public struct VGPUBufferUsage: OptionSet, Sendable {
  public let rawValue: UInt32

  public init(rawValue: UInt32) { self.rawValue = rawValue }

  public static let binding = Self(rawValue: 1 << 0)
  public static let indirect = Self(rawValue: 1 << 1)
}

public enum VGPUBufferViewError: Error, Equatable, Sendable {
  case invalidByteRange
  case arithmeticOverflow
}

public final class VGPUBuffer {
  public let sizeInBytes: Int
  public let usage: VGPUBufferUsage
  package let _box: any _VGPUStorageBox
  package let _backingByteRange: Range<Int>

  package init(
    sizeInBytes: Int,
    usage: VGPUBufferUsage,
    box: any _VGPUStorageBox,
    backingByteRange: Range<Int>
  ) {
    self.sizeInBytes = sizeInBytes
    self.usage = usage
    self._box = box
    self._backingByteRange = backingByteRange
  }

  public func slice(bytes: Range<Int>) throws -> VGPUBuffer {
    guard
      bytes.lowerBound >= 0,
      bytes.lowerBound < bytes.upperBound,
      bytes.upperBound <= sizeInBytes
    else {
      throw VGPUBufferViewError.invalidByteRange
    }
    let (lowerBound, lowerOverflow) = _backingByteRange.lowerBound
      .addingReportingOverflow(bytes.lowerBound)
    let (upperBound, upperOverflow) = _backingByteRange.lowerBound
      .addingReportingOverflow(bytes.upperBound)
    guard !lowerOverflow, !upperOverflow else {
      throw VGPUBufferViewError.arithmeticOverflow
    }
    return VGPUBuffer(
      sizeInBytes: bytes.count,
      usage: usage,
      box: _box,
      backingByteRange: lowerBound..<upperBound
    )
  }

  package func prepareForRead() throws -> _VGPUPreparedStorage {
    try _box.prepare(
      boundByteCount: _backingByteRange.upperBound,
      elementCount: nil,
      requiredAccess: .read
    )
  }
}

@available(*, unavailable)
extension VGPUBuffer: Sendable {}

extension VGPUStorage {
  public var buffer: VGPUBuffer {
    VGPUBuffer(
      sizeInBytes: sizeInBytes,
      usage: [.binding, additionalUsage],
      box: _box,
      backingByteRange: 0..<sizeInBytes
    )
  }
}

public struct _VGPUDrawProgramDescriptor: Equatable, Sendable {
  package let artifactID: String
  package let programID: String
  package let vertexEntryPointID: String
  package let fragmentEntryPointID: String
  package let artifact: _VGPUProgramArtifact?

  public init(
    artifactID: String,
    programID: String,
    vertexEntryPointID: String,
    fragmentEntryPointID: String,
    artifact: _VGPUProgramArtifact? = nil
  ) {
    self.artifactID = artifactID
    self.programID = programID
    self.vertexEntryPointID = vertexEntryPointID
    self.fragmentEntryPointID = fragmentEntryPointID
    self.artifact = artifact
  }
}

public protocol VGPUDrawProgram {
  static var _vgpuDrawProgramDescriptor: _VGPUDrawProgramDescriptor { get }
}
