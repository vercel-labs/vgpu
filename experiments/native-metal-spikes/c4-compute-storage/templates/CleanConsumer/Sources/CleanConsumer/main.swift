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
  let recorder = ErrorRecorder()
  let stopListening = gpu.onError { error in recorder.record(error) }
  let initial = (0..<8).map(UInt32.init)
  let expectedFinal: [UInt32] = [6, 14, 22, 30, 38, 46, 54, 62]
  let expectedAdvanceAudit: [UInt32] = [101, 2, 1, 2]
  let expectedMixAudit: [UInt32] = [202, 2, 2, 1]
  let negativeAuditSentinel: [UInt32] = [901, 902, 903, 904]
  let state = try gpu.pingPongStorage(UInt32.self, count: initial.count, initialValues: initial)
  let halfA = state.read
  let halfB = state.write
  let advanceAudit = try gpu.storage(UInt32.self, count: 4)
  let mixAudit = try gpu.storage(UInt32.self, count: 4)
  let negativeAudit = try gpu.storage(
    UInt32.self,
    count: 4,
    initialValues: negativeAuditSentinel
  )
  var roles: [String] = []

  func recordRoles() throws {
    if state.read === halfA && state.write === halfB {
      roles.append("A->B")
    } else if state.read === halfB && state.write === halfA {
      roles.append("B->A")
    } else {
      throw ConsumerError(description: "ping-pong storage lost its two alternating halves")
    }
  }

  try recordRoles()
  let advance = try gpu.compute(
    AdvanceState.self,
    bindings: .init(
      source: state.read,
      mask: state.read,
      destination: state.write,
      audit: advanceAudit
    )
  )
  _ = try advance.dispatch(x: 2, y: 1, z: 2)

  state.swap()
  try recordRoles()
  let mix = try gpu.compute(
    MixState.self,
    bindings: .init(
      source: state.read,
      mask: state.read,
      destination: state.write,
      audit: mixAudit
    )
  )
  _ = try mix.dispatch(x: 2, y: 2, z: 1)

  state.swap()
  try recordRoles()
  await gpu.settled()

  let finalState = try await state.read.read()
  let positiveAdvanceAudit = try await advanceAudit.read()
  let positiveMixAudit = try await mixAudit.read()
  try require(finalState == expectedFinal, "final state drifted: \(finalState)")
  try require(
    positiveAdvanceAudit == expectedAdvanceAudit,
    "advance audit drifted: \(positiveAdvanceAudit)"
  )
  try require(positiveMixAudit == expectedMixAudit, "mix audit drifted: \(positiveMixAudit)")

  let stateBeforeNegative = finalState
  let rejected = try gpu.compute(
    AdvanceState.self,
    bindings: .init(
      source: state.read,
      mask: state.read,
      destination: state.read,
      audit: negativeAudit
    )
  )
  var aliasingCode: String?
  var threwSynchronously = false
  do {
    _ = try rejected.dispatch(x: 2, y: 1, z: 2)
  } catch let error as VGPUError {
    threwSynchronously = true
    aliasingCode = error.code.rawValue
  }
  try require(threwSynchronously, "same-storage source/destination did not throw")
  try require(
    aliasingCode == VGPUErrorCode.storageAliasing.rawValue,
    "unexpected aliasing code: \(aliasingCode ?? "nil")"
  )
  await gpu.settled()
  let stateAfterNegative = try await state.read.read()
  let auditAfterNegative = try await negativeAudit.read()
  try require(stateAfterNegative == stateBeforeNegative, "rejected dispatch changed state")
  try require(auditAfterNegative == negativeAuditSentinel, "rejected dispatch changed its audit")
  try require(recorder.count == 0, "rejected dispatch reached onError")

  stopListening()
  try halfA.dispose()
  try halfB.dispose()
  try advanceAudit.dispose()
  try mixAudit.dispose()
  try negativeAudit.dispose()
  try gpu.dispose()
  try emit([
    "aliasing": [
      "auditUnchanged": true,
      "code": aliasingCode as Any,
      "onErrorCount": recorder.count,
      "stateUnchanged": true,
      "synchronous": threwSynchronously,
    ],
    "gate": "c4-compute-storage-consumer",
    "readbacks": [
      "advanceAudit": positiveAdvanceAudit,
      "final": finalState,
      "mixAudit": positiveMixAudit,
    ],
    "schemaVersion": 1,
    "sequence": [
      "explicitSets": ["advance:A->B", "mix:B->A"],
      "roles": roles,
      "submissionsBeforeFirstAwait": 2,
    ],
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
