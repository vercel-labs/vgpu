import Foundation

package struct DC1AuditSnapshot: Sendable {
  package let commitTrace: [String]
  package let computeIdentity: UInt64?
  package let computeGeneration: UInt64?
  package let drawIdentity: UInt64?
  package let drawGeneration: UInt64?
  package let viewRange: Range<Int>?
  package let consumerByteOffset: Int?
  package let physicalByteOffset: Int?
  package let directVertexCount: Int?
  package let cpuPacketReads: Int
  package let libraryLoadCount: Int
}

package final class DC1MetalAudit: @unchecked Sendable {
  package static let shared = DC1MetalAudit()
  private let lock = NSLock()
  private var trace: [String] = []
  private var compute: (UInt64, UInt64)?
  private var draw: (UInt64, UInt64)?
  private var range: Range<Int>?
  private var consumerOffset: Int?
  private var physicalOffset: Int?
  private var directCount: Int?
  private var packetReads = 0
  private var loads = 0

  package func reset() {
    lock.lock()
    defer { lock.unlock() }
    trace = []
    compute = nil
    draw = nil
    range = nil
    consumerOffset = nil
    physicalOffset = nil
    directCount = nil
    packetReads = 0
    loads = 0
  }

  package func recordLibraryLoad() {
    lock.lock()
    loads += 1
    lock.unlock()
  }

  package func recordPacketRead() {
    lock.lock()
    packetReads += 1
    lock.unlock()
  }

  package func recordCompute(identity: UInt64, generation: UInt64) {
    lock.lock()
    trace.append("computeCommit")
    compute = (identity, generation)
    lock.unlock()
  }

  package func recordDraw(
    identity: UInt64,
    generation: UInt64,
    viewRange: Range<Int>,
    consumerByteOffset: Int,
    physicalByteOffset: Int,
    directVertexCount: Int
  ) {
    lock.lock()
    defer { lock.unlock() }
    trace.append("frameCommit")
    draw = (identity, generation)
    range = viewRange
    consumerOffset = consumerByteOffset
    physicalOffset = physicalByteOffset
    directCount = directVertexCount
  }

  package var snapshot: DC1AuditSnapshot {
    lock.lock()
    defer { lock.unlock() }
    return DC1AuditSnapshot(
      commitTrace: trace,
      computeIdentity: compute?.0,
      computeGeneration: compute?.1,
      drawIdentity: draw?.0,
      drawGeneration: draw?.1,
      viewRange: range,
      consumerByteOffset: consumerOffset,
      physicalByteOffset: physicalOffset,
      directVertexCount: directCount,
      cpuPacketReads: packetReads,
      libraryLoadCount: loads
    )
  }
}
