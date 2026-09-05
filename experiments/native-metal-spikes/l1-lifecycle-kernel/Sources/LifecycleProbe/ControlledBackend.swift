import Foundation
import LifecycleKernel

enum ControlledOperationResult: Sendable {
  case success([UInt8])
  case failure(VGPUBackendFailure)
}

actor ControlledOperation {
  private var started = false
  private var result: ControlledOperationResult?
  private var resultContinuation: CheckedContinuation<ControlledOperationResult, Never>?
  private var startContinuations: [CheckedContinuation<Void, Never>] = []

  func run() async throws -> [UInt8] {
    precondition(!started, "a controlled operation can run only once")
    started = true
    let waitingForStart = startContinuations
    startContinuations.removeAll(keepingCapacity: false)
    for continuation in waitingForStart {
      continuation.resume()
    }

    let result: ControlledOperationResult
    if let resolved = self.result {
      result = resolved
    } else {
      result = await withCheckedContinuation { continuation in
        resultContinuation = continuation
      }
    }
    switch result {
    case .success(let bytes):
      return bytes
    case .failure(let error):
      throw error
    }
  }

  func waitUntilStarted() async {
    if started { return }
    await withCheckedContinuation { continuation in
      startContinuations.append(continuation)
    }
  }

  func resolve(_ result: ControlledOperationResult) {
    precondition(self.result == nil, "a controlled operation can resolve only once")
    self.result = result
    if let resultContinuation {
      self.resultContinuation = nil
      resultContinuation.resume(returning: result)
    }
  }

  var isResolved: Bool { result != nil }
}

final class ControlledBackend: VGPULifecycleBackend, @unchecked Sendable {
  private let lock = NSLock()
  private var nextGeneration: UInt64 = 1
  private var generationsByLabel: [String: VGPUBackendGeneration] = [:]
  private var operations: [String: ControlledOperation] = [:]
  private var released: [VGPUBackendGeneration] = []
  private var startedLabels: [String] = []
  private var submittedGenerations: [String: [VGPUBackendGeneration]] = [:]

  func allocateGeneration(label: String) throws -> VGPUBackendGeneration {
    try withLock {
      guard generationsByLabel[label] == nil else {
        throw VGPUBackendFailure(
          code: "DUPLICATE_LABEL",
          message: "generation label '\(label)' was reused"
        )
      }
      let generation = VGPUBackendGeneration(rawValue: nextGeneration)
      nextGeneration += 1
      generationsByLabel[label] = generation
      return generation
    }
  }

  func readGeneration(_ generation: VGPUBackendGeneration) async throws -> [UInt8] {
    let key = "read:\(generation.rawValue)"
    return try await operationStarted(key).run()
  }

  func execute(
    label: String,
    generations: [VGPUBackendGeneration]
  ) async throws {
    lock.withLock {
      submittedGenerations[label] = generations
    }
    _ = try await operationStarted("submit:\(label)").run()
  }

  func releaseGeneration(_ generation: VGPUBackendGeneration) {
    lock.withLock { released.append(generation) }
  }

  func planRead(forLabel label: String) throws -> ControlledOperation {
    let generation = try withLock {
      guard let generation = generationsByLabel[label] else {
        throw ProbeError("generation '\(label)' was not allocated")
      }
      return generation
    }
    return plan(key: "read:\(generation.rawValue)")
  }

  func planSubmission(_ label: String) -> ControlledOperation {
    plan(key: "submit:\(label)")
  }

  func releaseCount(forLabel label: String) throws -> Int {
    try withLock {
      guard let generation = generationsByLabel[label] else {
        throw ProbeError("generation '\(label)' was not allocated")
      }
      return released.filter { $0 == generation }.count
    }
  }

  func didStartSubmission(_ label: String) -> Bool {
    lock.withLock { startedLabels.contains("submit:\(label)") }
  }

  func generationCount(forSubmission label: String) -> Int? {
    lock.withLock { submittedGenerations[label]?.count }
  }

  private func plan(key: String) -> ControlledOperation {
    lock.withLock {
      precondition(operations[key] == nil, "operation '\(key)' was planned twice")
      let operation = ControlledOperation()
      operations[key] = operation
      return operation
    }
  }

  private func operationStarted(_ key: String) throws -> ControlledOperation {
    try withLock {
      guard let operation = operations[key] else {
        throw VGPUBackendFailure(
          code: "UNPLANNED_OPERATION",
          message: "operation '\(key)' was not planned"
        )
      }
      startedLabels.append(key)
      return operation
    }
  }

  private func withLock<Result>(_ body: () throws -> Result) rethrows -> Result {
    lock.lock()
    defer { lock.unlock() }
    return try body()
  }
}
