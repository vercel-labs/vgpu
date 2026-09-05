import Darwin
import Foundation
import GeneratedFixture
import VGPUABI
import VGPUCompute
import VGPUCore
import VGPUResources
import VGPUTesting

struct MetalProbeError: Error, CustomStringConvertible {
  let description: String
}

func require(_ condition: @autoclosure () throws -> Bool, _ message: String) throws {
  if try !condition() { throw MetalProbeError(description: message) }
}

@MainActor
func waitUntil(_ description: String, condition: () -> Bool) async throws {
  for _ in 0..<10_000 {
    if condition() { return }
    await Task.yield()
  }
  throw MetalProbeError(description: "timed out waiting for \(description)")
}

func emit(_ report: [String: Any]) throws {
  let data = try JSONSerialization.data(
    withJSONObject: report,
    options: [.sortedKeys, .withoutEscapingSlashes]
  )
  guard let json = String(data: data, encoding: .utf8) else {
    throw MetalProbeError(description: "could not encode JSON")
  }
  print(json)
}

@MainActor
func run() async throws {
  guard CommandLine.arguments.count == 3 else {
    throw MetalProbeError(description: "usage: MetalProbe <library.metallib> <manifest.json>")
  }
  let harness = try makeMetalHarness(
    metallibURL: URL(fileURLWithPath: CommandLine.arguments[1]),
    manifestURL: URL(fileURLWithPath: CommandLine.arguments[2])
  )
  let gpu = harness.gpu
  let initial = [
    Particle(mass: 10, id: 101),
    Particle(mass: 20, id: 202),
    Particle(mass: 30, id: 303),
    Particle(mass: 40, id: 404),
  ]
  let values: Values.Storage = try gpu.storage(
    Values.self,
    prefix: .init(prefix: 77),
    capacity: 4,
    access: .read,
    initialElements: initial
  )
  let short = try values.binding(elementCount: 2)
  let long = try values.binding(elementCount: 4)
  let output1 = try gpu.storage(UInt32.self, count: 2)
  let output2 = try gpu.storage(UInt32.self, count: 2)
  let compute = try gpu.compute(
    InspectValues.self,
    bindings: .init(values: short, output: output1)
  )

  let first = try compute.dispatch(x: 1)
  try compute.set(\.values, to: long)
  try compute.set(\.output, to: output2)
  let second = try compute.dispatch(x: 1)
  await harness.completionGate.waitUntilGPUCompleted(2)

  let snapshots = harness.submittedInputSnapshots
  try require(snapshots.map(\.range) == [28, 52], "Metal effective ranges drifted")
  try require(
    harness.immediateUploads == [[0, 28], [0, 52]],
    "Metal immediate-data uploads drifted"
  )
  try require(
    harness.reflection == ["buffer/0/16/4", "buffer/1/8/4", "buffer/30/8/4"],
    "Metal binding reflection drifted: \(harness.reflection)"
  )
  try require(
    snapshots.count == 2 && snapshots[0].identity == snapshots[1].identity
      && snapshots[0].generation == snapshots[1].generation,
    "Metal dispatches did not snapshot the same backing generation"
  )
  try values.dispose()
  try require(harness.containsSubmittedInput(), "Metal released an in-flight generation")

  let snapshotsBeforeSettlement = gpu._settledSnapshotCount
  let gpuSettlement = Task { @MainActor in await gpu.settled() }
  try await waitUntil("context settled snapshot") {
    gpu._settledSnapshotCount == snapshotsBeforeSettlement + 1
  }
  await harness.completionGate.releaseCompletions()
  await first.settled()
  await second.settled()
  await gpuSettlement.value
  try require(!harness.containsSubmittedInput(), "Metal retained the generation after completion")

  let readbacks = [try await output1.read(), try await output2.read()]
  try require(readbacks == [[2, 202], [4, 404]], "Metal readback drifted: \(readbacks)")
  try output1.dispose()
  try output2.dispose()
  try gpu.dispose()
  try emit([
    "device": harness.deviceName,
    "effectiveRanges": snapshots.map(\.range),
    "gate": "c2-generated-compute-metal",
    "generationReleaseAfterCompletion": true,
    "immediateUploads": harness.immediateUploads,
    "readbacks": readbacks,
    "reflection": harness.reflection,
    "sameBackingBuffer": true,
    "schemaVersion": 1,
    "status": "passed",
  ])
}

@main
enum MetalProbe {
  static func main() async {
    do {
      try await run()
    } catch {
      FileHandle.standardError.write(Data("\(error)\n".utf8))
      Darwin.exit(1)
    }
  }
}
