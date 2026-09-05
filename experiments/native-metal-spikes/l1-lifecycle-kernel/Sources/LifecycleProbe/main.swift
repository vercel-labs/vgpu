import Dispatch
import Foundation
import LifecycleKernel

struct ProbeError: Error, CustomStringConvertible, Sendable {
  let description: String

  init(_ description: String) {
    self.description = description
  }
}

func require(_ condition: @autoclosure () throws -> Bool, _ message: String) throws {
  guard try condition() else { throw ProbeError(message) }
}

func requireCode(
  _ error: any Error,
  _ expected: VGPUErrorCode,
  _ message: String
) throws {
  guard let error = error as? VGPUError, error.code == expected else {
    throw ProbeError("\(message): received \(error)")
  }
}

final class UncheckedBox<Value>: @unchecked Sendable {
  let value: Value

  init(_ value: Value) {
    self.value = value
  }
}

final class LockedValue<Value: Sendable>: @unchecked Sendable {
  private let lock = NSLock()
  private var storage: Value

  init(_ value: Value) {
    self.storage = value
  }

  var value: Value {
    lock.lock()
    defer { lock.unlock() }
    return storage
  }

  func set(_ value: Value) {
    lock.lock()
    storage = value
    lock.unlock()
  }
}

final class UnsubscribeCell: @unchecked Sendable {
  private let lock = NSLock()
  private var unsubscribe: (@Sendable () -> Void)?

  func install(_ unsubscribe: @escaping @Sendable () -> Void) {
    lock.lock()
    self.unsubscribe = unsubscribe
    lock.unlock()
  }

  func invoke() {
    let unsubscribe: (@Sendable () -> Void)?
    lock.lock()
    unsubscribe = self.unsubscribe
    lock.unlock()
    unsubscribe?()
  }
}

struct RecordedError: Equatable, Sendable {
  let code: String
  let message: String
  let metadata: [String: String]
}

actor ErrorRecorder {
  private var errors: [RecordedError] = []

  func receive(_ error: VGPUError) {
    errors.append(
      RecordedError(
        code: error.code.rawValue,
        message: error.message,
        metadata: error.metadata
      )
    )
  }

  func snapshot() -> [RecordedError] { errors }

  func makeHandler() -> @isolated(any) @Sendable (VGPUError) -> Void {
    receive
  }
}

actor BlockingErrorRecorder {
  nonisolated let firstDeliveryStarted = DispatchSemaphore(value: 0)
  nonisolated let allowFirstDeliveryToFinish = DispatchSemaphore(value: 0)
  private var errors: [RecordedError] = []

  func receive(_ error: VGPUError) {
    errors.append(
      RecordedError(
        code: error.code.rawValue,
        message: error.message,
        metadata: error.metadata
      )
    )
    if errors.count == 1 {
      firstDeliveryStarted.signal()
      allowFirstDeliveryToFinish.wait()
    }
  }

  func snapshot() -> [RecordedError] { errors }

  func makeHandler() -> @isolated(any) @Sendable (VGPUError) -> Void {
    receive
  }
}

actor SelfUnsubscribingErrorRecorder {
  nonisolated let unsubscribeCell = UnsubscribeCell()
  private var errors: [RecordedError] = []

  func receive(_ error: VGPUError) {
    errors.append(
      RecordedError(
        code: error.code.rawValue,
        message: error.message,
        metadata: error.metadata
      )
    )
    unsubscribeCell.invoke()
  }

  func snapshot() -> [RecordedError] { errors }

  func makeHandler() -> @isolated(any) @Sendable (VGPUError) -> Void {
    receive
  }
}

enum NestedSentinel: Error {
  case expected
}

struct ProbeReport: Encodable {
  let schemaVersion = 1
  let gate = "l1-lifecycle-kernel"
  let checks: [String: Bool]
}

@MainActor
func waitUntil(
  _ description: String,
  condition: () -> Bool
) async throws {
  for _ in 0..<10_000 {
    if condition() { return }
    await Task.yield()
  }
  throw ProbeError("timed out waiting for \(description)")
}

@MainActor
func testAccessGateAndObserverLane() async throws {
  let backend = ControlledBackend()
  let gpu = VGPU(backend: backend)

  try gpu._withAccessForProbe {
    try gpu._withAccessForProbe {}
    do {
      try gpu._withAccessForProbe { throw NestedSentinel.expected }
      throw ProbeError("nested throwing access unexpectedly returned")
    } catch NestedSentinel.expected {
      // The outer claim must remain installed after this nested throw.
    }
    try gpu._withAccessForProbe {}
  }
  do {
    try gpu._withAccessForProbe { throw NestedSentinel.expected }
    throw ProbeError("top-level throwing access unexpectedly returned")
  } catch NestedSentinel.expected {
    // A throwing outer body must still release the claim.
  }
  try gpu._withAccessForProbe {}

  let entered = DispatchSemaphore(value: 0)
  let release = DispatchSemaphore(value: 0)
  let holderFinished = DispatchSemaphore(value: 0)
  let holderFailure = LockedValue<String?>(nil)
  let gpuBox = UncheckedBox(gpu)
  DispatchQueue.global().async {
    defer { holderFinished.signal() }
    do {
      try gpuBox.value._withAccessForProbe {
        entered.signal()
        release.wait()
      }
    } catch {
      holderFailure.set(String(describing: error))
    }
  }
  try require(
    entered.wait(timeout: .now() + 2) == .success,
    "access holder did not enter"
  )

  let observerCalled = LockedValue(false)
  let unsubscribe = gpu.onError { _ in observerCalled.set(true) }
  try require(gpu.lifecycleState.rawValue == "open", "observer state lane blocked")

  let overlapFinished = DispatchSemaphore(value: 0)
  let overlapCode = LockedValue<String?>(nil)
  DispatchQueue.global().async {
    defer { overlapFinished.signal() }
    do {
      try gpuBox.value._withAccessForProbe {}
    } catch let error as VGPUError {
      overlapCode.set(error.code.rawValue)
    } catch {
      overlapCode.set("unexpected:\(error)")
    }
  }
  try require(
    overlapFinished.wait(timeout: .now() + 1) == .success,
    "overlapping access blocked instead of failing fast"
  )
  try require(
    overlapCode.value == VGPUErrorCode.concurrentAccess.rawValue,
    "overlapping access returned the wrong code"
  )

  do {
    try gpu.dispose()
    throw ProbeError("overlapping dispose unexpectedly succeeded")
  } catch {
    try requireCode(error, .concurrentAccess, "overlapping dispose")
  }
  try require(gpu.lifecycleState.rawValue == "open", "failed dispose mutated context")

  unsubscribe()
  unsubscribe()
  release.signal()
  try require(
    holderFinished.wait(timeout: .now() + 2) == .success,
    "access holder did not finish"
  )
  try require(holderFailure.value == nil, "access holder failed")
  try require(!observerCalled.value, "observer callback ran without publication")
  try gpu.dispose()
}

@MainActor
func testReadRegistrationLeaseAndSnapshot() async throws {
  let backend = ControlledBackend()
  let gpu = VGPU(backend: backend)
  let resource = try gpu._makeResource(label: "read")
  let readControl = try backend.planRead(forLabel: "read")

  let readTask = Task { @MainActor in try await resource.read() }
  await readControl.waitUntilStarted()
  try require(gpu._pendingWorkCount == 1, "read was not registered before backend await")
  try require(resource._leaseCount == 1, "read generation lease was not acquired")

  let snapshotsBefore = gpu._settledSnapshotCount
  let snapshotWait = Task { @MainActor in await gpu.settled() }
  try await waitUntil("context settled snapshot") {
    gpu._settledSnapshotCount == snapshotsBefore + 1
  }

  let later = try gpu._makeResource(label: "later")
  let laterControl = backend.planSubmission("later")
  let laterSubmission = try later._submit(label: "later")
  await laterControl.waitUntilStarted()

  try resource.dispose()
  try require(resource.lifecycleState.rawValue == "closed", "resource did not close immediately")
  try require(
    try backend.releaseCount(forLabel: "read") == 0,
    "resource generation released while read lease was active"
  )
  do {
    _ = try await resource.read()
    throw ProbeError("closed resource accepted another read")
  } catch {
    try requireCode(error, .resourceDisposed, "read after close")
  }

  await readControl.resolve(.success([7, 8, 9]))
  let bytes = try await readTask.value
  try require(bytes == [7, 8, 9], "read result drifted")
  await snapshotWait.value
  try require(
    !laterSubmission._isSettled,
    "context snapshot included work registered after the call"
  )
  try require(
    try backend.releaseCount(forLabel: "read") == 1,
    "closed read generation was not released exactly once"
  )
  try resource.dispose()
  try require(
    try backend.releaseCount(forLabel: "read") == 1,
    "idempotent resource dispose released twice"
  )

  await laterControl.resolve(.success([]))
  await laterSubmission.settled()
  try later.dispose()
  try require(
    try backend.releaseCount(forLabel: "later") == 1,
    "later generation release drifted"
  )
  try gpu.dispose()
  await gpu.settled()
}

@MainActor
func testPartialLeaseRollbackAndDeduplication() async throws {
  let backend = ControlledBackend()
  let gpu = VGPU(backend: backend)
  let first = try gpu._makeResource(label: "first")
  let closed = try gpu._makeResource(label: "closed")
  let untouched = try gpu._makeResource(label: "untouched")
  try closed.dispose()

  _ = backend.planSubmission("rollback")
  do {
    _ = try gpu._submit(
      label: "rollback",
      resources: [first, first, closed, untouched]
    )
    throw ProbeError("partial lease acquisition unexpectedly succeeded")
  } catch {
    try requireCode(error, .resourceDisposed, "partial lease rollback")
  }
  try require(first._leaseCount == 0, "first lease did not roll back")
  try require(closed._leaseCount == 0, "closed resource gained a lease")
  try require(untouched._leaseCount == 0, "resource after failure was touched")
  try require(gpu._pendingWorkCount == 0, "failed acquisition registered ledger work")
  try require(!backend.didStartSubmission("rollback"), "failed acquisition reached backend")

  let dedupControl = backend.planSubmission("dedup")
  let dedup = try gpu._submit(
    label: "dedup",
    resources: [first, first, untouched]
  )
  await dedupControl.waitUntilStarted()
  try require(
    backend.generationCount(forSubmission: "dedup") == 2,
    "duplicate generations were not deduplicated"
  )
  try require(first._leaseCount == 1, "duplicate generation acquired two leases")
  try first.dispose()
  try untouched.dispose()
  try require(
    try backend.releaseCount(forLabel: "first") == 0,
    "first generation released during submission"
  )
  await dedupControl.resolve(.success([]))
  await dedup.settled()
  try require(
    try backend.releaseCount(forLabel: "first") == 1
      && backend.releaseCount(forLabel: "untouched") == 1,
    "deduplicated generation leases did not release"
  )
  try gpu.dispose()
}

@MainActor
func testDuplicateCompletionIsIdempotent() async throws {
  let backend = ControlledBackend()
  let gpu = VGPU(backend: backend)
  let resource = try gpu._makeResource(label: "duplicate-finish")
  let recorder = ErrorRecorder()
  let handler = await recorder.makeHandler()
  let unsubscribe = gpu.onError(handler)
  let manual = try gpu._registerManualWork(resource: resource)
  let submission = manual.submission
  try resource.dispose()
  try require(
    try backend.releaseCount(forLabel: "duplicate-finish") == 0,
    "manual work did not retain its resource generation"
  )

  let waiterOne = Task { @MainActor in await submission.settled() }
  let waiterTwo = Task.detached { await submission.settled() }
  let injected = VGPUError(
    code: VGPUErrorCode(rawValue: "VGPU-L1-INJECTED"),
    message: "duplicate completion canary"
  )
  await withTaskGroup(of: Void.self) { group in
    for _ in 0..<2 {
      group.addTask { await manual.finish(error: injected) }
    }
  }
  await waiterOne.value
  await waiterTwo.value

  let received = await recorder.snapshot()
  let publishedCount = gpu._observerEvents.filter {
    if case .published(_, code: injected.code) = $0 { return true }
    return false
  }.count
  try require(received.count == 1, "duplicate finish delivered an error more than once")
  try require(publishedCount == 1, "duplicate finish published an error more than once")
  try require(gpu._pendingWorkCount == 0, "duplicate finish left a ledger entry")
  try require(
    try backend.releaseCount(forLabel: "duplicate-finish") == 1,
    "duplicate finish released its generation more than once"
  )
  unsubscribe()
  try gpu.dispose()
  await gpu.settled()
}

@MainActor
func testUnsubscribeCancelsScheduledDelivery() async throws {
  let backend = ControlledBackend()
  let gpu = VGPU(backend: backend)
  let resource = try gpu._makeResource(label: "scheduled-delivery")
  let recorder = ErrorRecorder()
  let handler = await recorder.makeHandler()
  let unsubscribe = gpu.onError(handler)
  let reachedBeforeStart = DispatchSemaphore(value: 0)
  let allowStartClaim = DispatchSemaphore(value: 0)
  gpu._setObserverBeforeStartHook { publication, subscription in
    guard publication == 1, subscription == 1 else { return }
    reachedBeforeStart.signal()
    allowStartClaim.wait()
  }

  let manual = try gpu._registerManualWork(resource: resource)
  let submission = manual.submission
  try resource.dispose()
  let injected = VGPUError(
    code: VGPUErrorCode(rawValue: "VGPU-L1-SCHEDULED"),
    message: "scheduled delivery cancellation canary"
  )
  let finish = Task.detached { await manual.finish(error: injected) }
  try require(
    reachedBeforeStart.wait(timeout: .now() + 2) == .success,
    "delivery did not reach the before-start barrier"
  )

  unsubscribe()
  unsubscribe()
  await submission.settled()
  let beforeReleasingBarrier = await recorder.snapshot()
  try require(
    beforeReleasingBarrier.isEmpty,
    "unsubscribe ran a handler that had not started"
  )

  gpu._setObserverBeforeStartHook(nil)
  allowStartClaim.signal()
  try await waitUntil("scheduled delivery start rejection") {
    gpu._observerEvents.contains {
      if case .startRejected(publication: 1, subscription: 1) = $0 { return true }
      return false
    }
  }
  await finish.value
  let afterReleasingBarrier = await recorder.snapshot()
  try require(
    afterReleasingBarrier.isEmpty,
    "cancelled scheduled handler started after unsubscribe returned"
  )
  try require(
    try backend.releaseCount(forLabel: "scheduled-delivery") == 1,
    "cancelled delivery changed generation release accounting"
  )
  try gpu.dispose()
  await gpu.settled()
}

@MainActor
func testSubmissionScopeErrorDeliveryAndUnsubscribe() async throws {
  let backend = ControlledBackend()
  let gpu = VGPU(backend: backend)
  let resource = try gpu._makeResource(label: "errors")
  let firstControl = backend.planSubmission("first-error")
  let secondControl = backend.planSubmission("second-error")
  let blockingRecorder = BlockingErrorRecorder()
  let orderedRecorder = ErrorRecorder()
  let blockingHandler = await blockingRecorder.makeHandler()
  let orderedHandler = await orderedRecorder.makeHandler()
  let unsubscribeBlocking = gpu.onError(blockingHandler)
  let unsubscribeOrdered = gpu.onError(orderedHandler)

  let first = try resource._submit(label: "first-error")
  let second = try resource._submit(label: "second-error")
  await firstControl.waitUntilStarted()
  await secondControl.waitUntilStarted()

  await firstControl.resolve(
    .failure(VGPUBackendFailure(code: "DEVICE_LOST", message: "first injected failure"))
  )
  try require(
    blockingRecorder.firstDeliveryStarted.wait(timeout: .now() + 2) == .success,
    "first actor-isolated error delivery did not start"
  )

  await secondControl.resolve(
    .failure(VGPUBackendFailure(code: "DEVICE_LOST", message: "second injected failure"))
  )
  try await waitUntil("second error enqueue") {
    gpu._observerEvents.contains {
      if case .enqueued(publication: 2, subscription: 2) = $0 { return true }
      return false
    }
  }

  unsubscribeBlocking()
  unsubscribeBlocking()
  await second.settled()
  try require(!first._isSettled, "second settlement waited for first handler")
  let orderedBeforeRelease = await orderedRecorder.snapshot()
  try require(orderedBeforeRelease.count == 2, "ordered subscriber missed an error")
  try require(
    orderedBeforeRelease.map(\.metadata["operation"])
      == ["submission.first-error", "submission.second-error"],
    "one subscription did not preserve publication order"
  )
  for error in orderedBeforeRelease {
    try require(
      error.code == VGPUErrorCode.backendOperationFailed.rawValue,
      "backend failure mapped to the wrong VGPUError code"
    )
    try require(error.metadata["backendCode"] == "DEVICE_LOST", "backend code was lost")
  }

  blockingRecorder.allowFirstDeliveryToFinish.signal()
  await first.settled()
  let blockingErrors = await blockingRecorder.snapshot()
  try require(blockingErrors.count == 1, "unsubscribe did not invalidate queued delivery")

  unsubscribeOrdered()
  unsubscribeOrdered()
  let thirdControl = backend.planSubmission("unobserved-error")
  let third = try resource._submit(label: "unobserved-error")
  await thirdControl.waitUntilStarted()
  try resource.dispose()
  await thirdControl.resolve(
    .failure(VGPUBackendFailure(code: "TIMEOUT", message: "third injected failure"))
  )
  await third.settled()
  try require(
    gpu._observerEvents.contains {
      if case .unobserved(publication: 3, code: .backendOperationFailed) = $0 { return true }
      return false
    },
    "unobserved deferred failure did not emit one diagnostic event"
  )
  try require(
    try backend.releaseCount(forLabel: "errors") == 1,
    "submission leases did not retain then release the closed generation"
  )
  try gpu.dispose()
  await gpu.settled()
}

@MainActor
func testReadFailureIsThrownOnly() async throws {
  let backend = ControlledBackend()
  let gpu = VGPU(backend: backend)
  let resource = try gpu._makeResource(label: "read-failure")
  let readControl = try backend.planRead(forLabel: "read-failure")
  let recorder = ErrorRecorder()
  let handler = await recorder.makeHandler()
  let unsubscribe = gpu.onError(handler)

  let read = Task { @MainActor in try await resource.read() }
  await readControl.waitUntilStarted()
  try resource.dispose()
  await readControl.resolve(
    .failure(VGPUBackendFailure(code: "READBACK", message: "injected read failure"))
  )
  do {
    _ = try await read.value
    throw ProbeError("failed read unexpectedly returned")
  } catch let error as VGPUError {
    try require(
      error.code.rawValue == VGPUErrorCode.backendOperationFailed.rawValue,
      "read failure mapped to wrong code"
    )
    try require(error.metadata["operation"] == "resource.read", "read operation metadata drifted")
  }
  let deliveredReadErrors = await recorder.snapshot()
  try require(deliveredReadErrors.isEmpty, "read failure was delivered to onError")
  try require(gpu._observerEvents.isEmpty, "read failure entered deferred-error registry")
  try require(gpu._pendingWorkCount == 0, "failed read left ledger work pending")
  try require(
    try backend.releaseCount(forLabel: "read-failure") == 1,
    "failed read did not release its closed generation"
  )
  unsubscribe()
  try gpu.dispose()
  await gpu.settled()
}

@MainActor
func testContextClose() async throws {
  let backend = ControlledBackend()
  let gpu = VGPU(backend: backend)
  let idle = try gpu._makeResource(label: "idle")
  let prior = try gpu._makeResource(label: "prior-error")
  let priorControl = backend.planSubmission("prior-error")
  let priorSubmission = try prior._submit(label: "prior-error")
  await priorControl.waitUntilStarted()
  await priorControl.resolve(
    .failure(VGPUBackendFailure(code: "PRIOR", message: "unobserved before close"))
  )
  await priorSubmission.settled()
  try prior.dispose()

  let busy = try gpu._makeResource(label: "busy")
  let busyControl = backend.planSubmission("busy")
  let busySubmission = try busy._submit(label: "busy")
  await busyControl.waitUntilStarted()
  try require(gpu._registeredResourceCount == 3, "context did not register children")
  try gpu.dispose()
  try require(gpu.lifecycleState.rawValue == "closed", "context did not close")
  try require(
    idle.lifecycleState.rawValue == "closed" && busy.lifecycleState.rawValue == "closed",
    "context did not close children"
  )
  try require(
    try backend.releaseCount(forLabel: "idle") == 1,
    "context did not release idle generation"
  )
  try require(
    try backend.releaseCount(forLabel: "busy") == 0,
    "context released a generation with pending work"
  )
  try require(gpu._registeredResourceCount == 0, "closed context retained registry entries")
  try gpu.dispose()
  try idle.dispose()
  try busy.dispose()
  try require(
    try backend.releaseCount(forLabel: "idle") == 1,
    "idempotent close released idle generation twice"
  )
  do {
    _ = try gpu._makeResource(label: "after-close")
    throw ProbeError("closed context accepted a resource")
  } catch {
    try requireCode(error, .gpuDisposed, "resource creation after context close")
  }
  let lateRecorder = SelfUnsubscribingErrorRecorder()
  let lateHandler = await lateRecorder.makeHandler()
  let unsubscribe = gpu.onError(lateHandler)
  lateRecorder.unsubscribeCell.install(unsubscribe)
  let errorsBeforeFutureCompletion = await lateRecorder.snapshot()
  try require(
    errorsBeforeFutureCompletion.isEmpty,
    "subscriber installed after close received an earlier unobserved error"
  )
  let snapshotsBeforeDrain = gpu._settledSnapshotCount
  let drain = Task { @MainActor in await gpu.settled() }
  try await waitUntil("closed-context settled snapshot") {
    gpu._settledSnapshotCount == snapshotsBeforeDrain + 1
  }
  await busyControl.resolve(
    .failure(VGPUBackendFailure(code: "BUSY", message: "completion after close"))
  )
  await busySubmission.settled()
  await drain.value
  let lateErrors = await lateRecorder.snapshot()
  try require(
    lateErrors.map(\.metadata["operation"]) == ["submission.busy"],
    "late subscriber backlog or future delivery drifted"
  )
  unsubscribe()
  try require(
    try backend.releaseCount(forLabel: "busy") == 1,
    "pending generation did not release after closed-context work settled"
  )
}

@main
struct LifecycleProbe {
  @MainActor
  static func main() async throws {
    try await testAccessGateAndObserverLane()
    try await testReadRegistrationLeaseAndSnapshot()
    try await testPartialLeaseRollbackAndDeduplication()
    try await testDuplicateCompletionIsIdempotent()
    try await testUnsubscribeCancelsScheduledDelivery()
    try await testSubmissionScopeErrorDeliveryAndUnsubscribe()
    try await testReadFailureIsThrownOnly()
    try await testContextClose()

    let report = ProbeReport(
      checks: [
        "accessGateFailFast": true,
        "accessGateStackReentrancy": true,
        "contextCloseIdempotent": true,
        "contextSettledSnapshot": true,
        "deferredGenerationRelease": true,
        "duplicateCompletionIdempotent": true,
        "errorActorAndOrder": true,
        "errorMapping": true,
        "lateSubscriberNoBacklog": true,
        "observerLaneIndependent": true,
        "partialLeaseRollback": true,
        "readRegistersBeforeAwait": true,
        "readThrowsWithoutObserverDuplicate": true,
        "selfUnsubscribeReentrant": true,
        "submissionSettledScoped": true,
        "unsubscribeCancelsScheduled": true,
        "unsubscribeInvalidatesQueued": true,
      ]
    )
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    let encoded = try encoder.encode(report)
    print(String(decoding: encoded, as: UTF8.self))
  }
}
