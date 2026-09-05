import Foundation
import VGPUCore
import VGPUMetal
import _VGPUMetalComputeImpl
import _VGPUMetalCoreImpl
import _VGPUMetalRenderImpl
import _VGPUMetalResourcesImpl

public struct DC1MetalEvidence: Sendable {
  public let commitTrace: [String]
  public let viewRange: [Int]
  public let consumerByteOffset: Int
  public let physicalByteOffset: Int
  public let directVertexCount: Int
  public let sameAllocationGeneration: Bool
  public let cpuPacketReads: Int
  public let libraryLoadCount: Int
}

public final class DC1MetalHarness {
  public let gpu: VGPU

  fileprivate init(gpu: VGPU) { self.gpu = gpu }

  public var evidence: DC1MetalEvidence {
    let value = DC1MetalAudit.shared.snapshot
    let same =
      value.computeIdentity != nil
      && value.computeIdentity == value.drawIdentity
      && value.computeGeneration == value.drawGeneration
    return DC1MetalEvidence(
      commitTrace: value.commitTrace,
      viewRange: value.viewRange.map { [$0.lowerBound, $0.upperBound] } ?? [],
      consumerByteOffset: value.consumerByteOffset ?? -1,
      physicalByteOffset: value.physicalByteOffset ?? -1,
      directVertexCount: value.directVertexCount ?? -1,
      sameAllocationGeneration: same,
      cpuPacketReads: value.cpuPacketReads,
      libraryLoadCount: value.libraryLoadCount
    )
  }
}

@available(*, unavailable)
extension DC1MetalHarness: Sendable {}

public func makeDC1MetalHarness() throws -> DC1MetalHarness {
  DC1MetalAudit.shared.reset()
  return DC1MetalHarness(gpu: try VGPU.metal())
}
