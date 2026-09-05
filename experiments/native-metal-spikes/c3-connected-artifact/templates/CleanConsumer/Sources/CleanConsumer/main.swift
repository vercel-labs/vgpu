import AppShaders
import Darwin
import Foundation
import VGPUCompute
import VGPUCore
import VGPUMetal
import VGPUResources

private struct ConsumerError: Error, CustomStringConvertible {
  let description: String
}

private func require(_ condition: @autoclosure () -> Bool, _ message: String) throws {
  if !condition() {
    throw ConsumerError(description: message)
  }
}

private func emit(_ report: [String: Any]) throws {
  let bytes = try JSONSerialization.data(
    withJSONObject: report,
    options: [.sortedKeys, .withoutEscapingSlashes]
  )
  guard let json = String(data: bytes, encoding: .utf8) else {
    throw ConsumerError(description: "could not encode the consumer report")
  }
  print(json)
}

@MainActor
private func run() async throws {
  let gpu = try VGPU.metal()
  let values: Values.Storage = try gpu.storage(
    Values.self,
    prefix: .init(prefix: 77),
    capacity: 4,
    access: .read,
    initialElements: [
      Particle(mass: 10, id: 101),
      Particle(mass: 20, id: 202),
      Particle(mass: 30, id: 303),
      Particle(mass: 40, id: 404),
    ]
  )
  let short = try values.binding(elementCount: 2)
  let long = try values.binding(elementCount: 4)
  let firstOutput = try gpu.storage(UInt32.self, count: 2)
  let secondOutput = try gpu.storage(UInt32.self, count: 2)
  let compute = try gpu.compute(
    AssemblyRuntimeSizedStorage.self,
    bindings: .init(values: short, output: firstOutput)
  )

  let first = try compute.dispatch(x: 1)
  try compute.set(\.values, to: long)
  try compute.set(\.output, to: secondOutput)
  let second = try compute.dispatch(x: 1)
  await first.settled()
  await second.settled()
  await gpu.settled()

  let readbacks = [try await firstOutput.read(), try await secondOutput.read()]
  try require(
    readbacks == [[2, 202], [4, 404]], "connected artifact readback drifted: \(readbacks)")

  try values.dispose()
  try firstOutput.dispose()
  try secondOutput.dispose()
  try gpu.dispose()
  try emit([
    "gate": "c3-connected-artifact-consumer",
    "readbacks": readbacks,
    "schemaVersion": 1,
    "status": "passed",
  ])
}

@main
private enum CleanConsumer {
  static func main() async {
    do {
      try await run()
    } catch {
      FileHandle.standardError.write(Data("\(error)\n".utf8))
      Darwin.exit(1)
    }
  }
}
