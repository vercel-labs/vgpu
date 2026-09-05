import AppShaders
import Darwin
import Foundation
import VGPUCompute
import VGPUCore
import VGPUMetal
import VGPURender
import VGPUResources

private struct ConsumerError: Error, CustomStringConvertible {
  let description: String
}

private final class ErrorRecorder: @unchecked Sendable {
  private let lock = NSLock()
  private var codes: [String] = []

  func record(_ error: VGPUError) {
    lock.lock()
    codes.append(error.code.rawValue)
    lock.unlock()
  }

  var count: Int {
    lock.lock()
    defer { lock.unlock() }
    return codes.count
  }
}

private enum Scenario: Equatable {
  case blue
  case red
  case green

  var packetRange: Range<Int> {
    switch self {
    case .blue: 0..<16
    case .red, .green: 16..<32
    }
  }

  var expectedPixel: [UInt8] {
    switch self {
    case .blue: [0, 0, 255, 255]
    case .red: [255, 0, 0, 255]
    case .green: [0, 255, 0, 255]
    }
  }
}

private func require(_ condition: @autoclosure () -> Bool, _ message: String) throws {
  if !condition() { throw ConsumerError(description: message) }
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
private func runScenario(_ scenario: Scenario) async throws -> ([UInt8], Int) {
  let gpu = try VGPU.metal()
  let errors = ErrorRecorder()
  let stopListening = gpu.onError { error in errors.record(error) }
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
  let packet = try arguments.buffer.slice(bytes: scenario.packetRange)
  let triangles = try gpu.draw(ConsumePacket.self, vertices: 0)
  let output = try gpu.target(width: 4, height: 4)

  if scenario == .green {
    let producer = try gpu.compute(
      ProducePacket.self,
      bindings: .init(produced: arguments)
    )
    _ = try producer.dispatch(x: 1)
  }
  _ = try gpu.frame { frame in
    try frame.pass(target: output, color: .clear([0, 0, 1, 1])) { pass in
      try pass.draw(triangles, indirect: packet)
    }
  }

  // This is deliberately the first suspension after the positive submissions.
  let pixels = Array(try await output.read())
  let expected = scenario.expectedPixel
  try require(pixels.count == 4 * 4 * 4, "unexpected target byte count: \(pixels.count)")
  for offset in stride(from: 0, to: pixels.count, by: 4) {
    try require(
      Array(pixels[offset..<(offset + 4)]) == expected,
      "target pixel drifted at byte \(offset)"
    )
  }
  await gpu.settled()
  try require(errors.count == 0, "positive scenario reached onError")
  stopListening()
  try arguments.dispose()
  try gpu.dispose()
  return (Array(pixels[0..<4]), errors.count)
}

@MainActor
private func run() async throws {
  let blue = try await runScenario(.blue)
  let red = try await runScenario(.red)
  let green = try await runScenario(.green)
  try require(blue.1 + red.1 + green.1 == 0, "positive controls reported errors")
  try emit([
    "controls": [
      "blue": blue.0,
      "green": green.0,
      "red": red.0,
    ],
    "gate": "dc1-compute-draw-consumer",
    "onErrorCount": 0,
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
