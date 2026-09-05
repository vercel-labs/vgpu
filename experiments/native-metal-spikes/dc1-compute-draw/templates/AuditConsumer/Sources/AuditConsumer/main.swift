import AppShaders
import Darwin
import Foundation
import VGPUCompute
import VGPUCore
import VGPURender
import VGPUResources
import VGPUTesting

private struct AuditError: Error, CustomStringConvertible {
  let description: String
}

private func require(_ condition: @autoclosure () -> Bool, _ message: String) throws {
  if !condition() { throw AuditError(description: message) }
}

private func emit(_ report: [String: Any]) throws {
  let bytes = try JSONSerialization.data(
    withJSONObject: report,
    options: [.sortedKeys, .withoutEscapingSlashes]
  )
  guard let json = String(data: bytes, encoding: .utf8) else {
    throw AuditError(description: "could not encode the audit report")
  }
  print(json)
}

@MainActor
private func run() async throws {
  let harness = try makeDC1MetalHarness()
  let gpu = harness.gpu
  let arguments = try gpu.storage(
    UInt32.self,
    count: 8,
    access: .readWrite,
    additionalUsage: [.indirect],
    initial: [
      0, 0, 0, 0,
      3, 1, 3, 0,
    ]
  )
  let packet = try arguments.buffer.slice(bytes: 16..<32)
  let producer = try gpu.compute(
    ProducePacket.self,
    bindings: .init(produced: arguments)
  )
  let triangles = try gpu.draw(ConsumePacket.self, vertices: 0)
  let output = try gpu.target(width: 4, height: 4)

  _ = try producer.dispatch(x: 1)
  _ = try gpu.frame { frame in
    try frame.pass(target: output, color: .clear([0, 0, 1, 1])) { pass in
      try pass.draw(triangles, indirect: packet)
    }
  }
  let pixels = try await output.read()
  try require(pixels.count == 64, "unexpected target byte count")
  for offset in stride(from: 0, to: pixels.count, by: 4) {
    try require(
      Array(pixels[offset..<(offset + 4)]) == [0, 255, 0, 255],
      "Metal audit target was not exact green"
    )
  }
  await gpu.settled()

  let evidence = harness.evidence
  try require(
    evidence.libraryLoadCount == 1,
    "compute and render did not share one authenticated Metal library"
  )
  try emit([
    "commitTrace": evidence.commitTrace,
    "consumerByteOffset": evidence.consumerByteOffset,
    "cpuPacketReads": evidence.cpuPacketReads,
    "directVertexCount": evidence.directVertexCount,
    "gate": "dc1-compute-draw-metal-audit",
    "physicalByteOffset": evidence.physicalByteOffset,
    "sameAllocationGeneration": evidence.sameAllocationGeneration,
    "schemaVersion": 1,
    "status": "passed",
    "viewRange": evidence.viewRange,
  ])
}

@main
private enum AuditConsumer {
  static func main() async {
    do {
      try await run()
    } catch {
      FileHandle.standardError.write(Data("\(error)\n".utf8))
      Darwin.exit(1)
    }
  }
}
