import Foundation
import VGPUABI
import _VGPUBackendSPI

extension NSLock {
  fileprivate func withCriticalRegion<Result>(_ body: () throws -> Result) rethrows -> Result {
    lock()
    defer { unlock() }
    return try body()
  }
}

public struct VGPUErrorCode: RawRepresentable, Hashable, Sendable {
  public let rawValue: String

  public init(rawValue: String) { self.rawValue = rawValue }

  public static let concurrentAccess = Self(rawValue: "VGPU-NATIVE-CONCURRENT-ACCESS")
  public static let gpuDisposed = Self(rawValue: "VGPU-GPU-DISPOSED")
  public static let contextMismatch = Self(rawValue: "VGPU-NATIVE-CONTEXT-MISMATCH")
  package static let invalidBindings = Self(rawValue: "VGPU-NATIVE-INVALID-BINDINGS")
  package static let invalidDispatch = Self(rawValue: "VGPU-NATIVE-INVALID-DISPATCH")
  package static let backendOperationFailed = Self(
    rawValue: "VGPU-NATIVE-BACKEND-OPERATION-FAILED"
  )
}

public struct VGPUError: Error, LocalizedError, Sendable {
  public let code: VGPUErrorCode
  public let message: String
  package let metadata: [String: String]

  public init(code: VGPUErrorCode, message: String) {
    self.code = code
    self.message = message
    self.metadata = [:]
  }

  package init(code: VGPUErrorCode, message: String, metadata: [String: String]) {
    self.code = code
    self.message = message
    self.metadata = metadata
  }

  public var errorDescription: String? { message }
}

private final class VGPUAccessGate: @unchecked Sendable {
  private let lock = NSLock()
  private let threadDictionaryKey = "vgpu.generated-compute.access.\(UUID().uuidString)"
  private var isClaimed = false

  func withAccess<Result>(_ body: () throws -> Result) throws -> Result {
    let dictionary = Thread.current.threadDictionary
    if let depth = dictionary[threadDictionaryKey] as? Int, depth > 0 {
      dictionary[threadDictionaryKey] = depth + 1
      defer { dictionary[threadDictionaryKey] = depth }
      return try body()
    }

    lock.lock()
    let claimed = !isClaimed
    if claimed { isClaimed = true }
    lock.unlock()
    guard claimed else {
      throw VGPUError(
        code: .concurrentAccess,
        message: "The VGPU object graph is already in use by another owner."
      )
    }

    dictionary[threadDictionaryKey] = 1
    defer {
      dictionary.removeObject(forKey: threadDictionaryKey)
      lock.lock()
      isClaimed = false
      lock.unlock()
    }
    return try body()
  }
}

package final class VGPUCompletionCell: @unchecked Sendable {
  private let lock = NSLock()
  private var resolved = false
  private var waiters: [CheckedContinuation<Void, Never>] = []

  package func wait() async {
    await withCheckedContinuation { continuation in
      lock.lock()
      if resolved {
        lock.unlock()
        continuation.resume()
      } else {
        waiters.append(continuation)
        lock.unlock()
      }
    }
  }

  package func resolve() {
    lock.lock()
    guard !resolved else {
      lock.unlock()
      return
    }
    resolved = true
    let current = waiters
    waiters.removeAll(keepingCapacity: false)
    lock.unlock()
    for waiter in current { waiter.resume() }
  }
}

private struct ErrorEnvelope: Sendable {
  let publication: UInt64
  let error: VGPUError
}

package enum VGPUObserverEvent: Equatable, Sendable {
  case published(publication: UInt64, code: VGPUErrorCode)
  case unobserved(publication: UInt64, code: VGPUErrorCode)
}

private struct QueuedErrorDelivery: Sendable {
  let envelope: ErrorEnvelope
  let completion: VGPUCompletionCell
}

private final class ErrorSubscription: @unchecked Sendable {
  let id: UInt64

  private let lock = NSLock()
  private let handler: @isolated(any) @Sendable (VGPUError) -> Void
  private var active = true
  private var current: QueuedErrorDelivery?
  private var handlerStarted = false
  private var queued: [QueuedErrorDelivery] = []

  init(id: UInt64, handler: @escaping @isolated(any) @Sendable (VGPUError) -> Void) {
    self.id = id
    self.handler = handler
  }

  func deactivate() -> [QueuedErrorDelivery] {
    lock.withCriticalRegion {
      guard active else { return [] }
      active = false
      var invalidated = queued
      queued.removeAll(keepingCapacity: false)
      if let current, !handlerStarted {
        invalidated.insert(current, at: 0)
        self.current = nil
      }
      return invalidated
    }
  }

  func resolveInvalidated(_ invalidated: [QueuedErrorDelivery]) {
    for delivery in invalidated { delivery.completion.resolve() }
  }

  func enqueue(_ envelope: ErrorEnvelope) -> VGPUCompletionCell {
    let completion = VGPUCompletionCell()
    let delivery = QueuedErrorDelivery(envelope: envelope, completion: completion)
    let disposition = lock.withCriticalRegion { () -> Bool? in
      guard active else { return nil }
      guard current == nil else {
        queued.append(delivery)
        return false
      }
      current = delivery
      handlerStarted = false
      return true
    }
    guard let shouldStart = disposition else {
      completion.resolve()
      return completion
    }
    if shouldStart { start(delivery) }
    return completion
  }

  private func start(_ delivery: QueuedErrorDelivery) {
    Task { @Sendable in
      await deliver(delivery, isolation: handler.isolation)
    }
  }

  private func deliver(
    _ delivery: QueuedErrorDelivery,
    isolation: isolated (any Actor)?
  ) async {
    guard claimHandlerStart(delivery) else { return }
    await handler(delivery.envelope.error)
    delivery.completion.resolve()
    finishCurrent(delivery)
  }

  private func claimHandlerStart(_ delivery: QueuedErrorDelivery) -> Bool {
    lock.withCriticalRegion {
      guard
        active,
        current?.completion === delivery.completion,
        !handlerStarted
      else {
        return false
      }
      handlerStarted = true
      return true
    }
  }

  private func finishCurrent(_ delivery: QueuedErrorDelivery) {
    let next = lock.withCriticalRegion { () -> QueuedErrorDelivery? in
      guard current?.completion === delivery.completion else { return nil }
      current = nil
      handlerStarted = false
      if active, !queued.isEmpty {
        let next = queued.removeFirst()
        current = next
        return next
      }
      return nil
    }
    if let next { start(next) }
  }
}

private actor ErrorPublicationLane {
  private var nextPublication: UInt64 = 1

  func publish(_ error: VGPUError, through registry: VGPUErrorObserverRegistry) async {
    let publication = nextPublication
    nextPublication += 1
    let observers = registry.preparePublication(publication: publication, code: error.code)
    guard !observers.isEmpty else {
      registry.record(.unobserved(publication: publication, code: error.code))
      return
    }
    var completions: [VGPUCompletionCell] = []
    let envelope = ErrorEnvelope(publication: publication, error: error)
    for observer in observers { completions.append(observer.enqueue(envelope)) }
    for completion in completions { await completion.wait() }
  }
}

package final class VGPUErrorObserverRegistry: @unchecked Sendable {
  private let lock = NSLock()
  private let lane = ErrorPublicationLane()
  private var nextID: UInt64 = 1
  private var subscriptions: [UInt64: ErrorSubscription] = [:]
  private var order: [UInt64] = []
  private var recordedEvents: [VGPUObserverEvent] = []

  package func subscribe(
    _ handler: @escaping @isolated(any) @Sendable (VGPUError) -> Void
  ) -> @Sendable () -> Void {
    let subscription = lock.withCriticalRegion { () -> ErrorSubscription in
      let id = nextID
      nextID += 1
      let subscription = ErrorSubscription(id: id, handler: handler)
      subscriptions[id] = subscription
      order.append(id)
      return subscription
    }
    return { [weak self, weak subscription] in
      guard let self, let subscription else { return }
      let invalidated = self.lock.withCriticalRegion { () -> [QueuedErrorDelivery] in
        self.subscriptions.removeValue(forKey: subscription.id)
        self.order.removeAll { $0 == subscription.id }
        return subscription.deactivate()
      }
      subscription.resolveInvalidated(invalidated)
    }
  }

  fileprivate func preparePublication(
    publication: UInt64,
    code: VGPUErrorCode
  ) -> [ErrorSubscription] {
    lock.withCriticalRegion {
      recordedEvents.append(.published(publication: publication, code: code))
      return order.compactMap { subscriptions[$0] }
    }
  }

  fileprivate func record(_ event: VGPUObserverEvent) {
    lock.withCriticalRegion { recordedEvents.append(event) }
  }

  package func publish(_ error: VGPUError) async {
    await lane.publish(error, through: self)
  }

  package var events: [VGPUObserverEvent] {
    lock.withCriticalRegion { recordedEvents }
  }
}

package final class VGPUWorkLedger: @unchecked Sendable {
  private let lock = NSLock()
  private let observers: VGPUErrorObserverRegistry
  private var nextID: UInt64 = 1
  private var pending: [UInt64: VGPUCompletionCell] = [:]
  private var snapshotCounter: UInt64 = 0

  package init(observers: VGPUErrorObserverRegistry) { self.observers = observers }

  package func register(leases: [any _VGPUResourceLease]) -> VGPUWorkTicket {
    lock.lock()
    let id = nextID
    nextID += 1
    let completion = VGPUCompletionCell()
    pending[id] = completion
    lock.unlock()
    return VGPUWorkTicket(
      id: id,
      completion: completion,
      leases: leases,
      ledger: self,
      observers: observers
    )
  }

  package func snapshot() -> [VGPUCompletionCell] {
    lock.lock()
    defer { lock.unlock() }
    snapshotCounter += 1
    return pending.keys.sorted().compactMap { pending[$0] }
  }

  package var pendingCount: Int {
    lock.lock()
    defer { lock.unlock() }
    return pending.count
  }

  package var snapshotCount: UInt64 {
    lock.lock()
    defer { lock.unlock() }
    return snapshotCounter
  }

  fileprivate func complete(_ id: UInt64) {
    lock.lock()
    let completion = pending.removeValue(forKey: id)
    lock.unlock()
    completion?.resolve()
  }
}

package final class VGPUWorkTicket: @unchecked Sendable {
  package let completion: VGPUCompletionCell

  private let lock = NSLock()
  private let id: UInt64
  private let leases: [any _VGPUResourceLease]
  private let ledger: VGPUWorkLedger
  private let observers: VGPUErrorObserverRegistry
  private var finished = false

  fileprivate init(
    id: UInt64,
    completion: VGPUCompletionCell,
    leases: [any _VGPUResourceLease],
    ledger: VGPUWorkLedger,
    observers: VGPUErrorObserverRegistry
  ) {
    self.id = id
    self.completion = completion
    self.leases = leases
    self.ledger = ledger
    self.observers = observers
  }

  package func finish(error: VGPUError? = nil) async {
    guard claimFinish() else { return }
    for lease in leases { lease.release() }
    if let error { await observers.publish(error) }
    ledger.complete(id)
  }

  package func abort() {
    guard claimFinish() else { return }
    for lease in leases { lease.release() }
    ledger.complete(id)
  }

  private func claimFinish() -> Bool {
    lock.lock()
    defer { lock.unlock() }
    guard !finished else { return false }
    finished = true
    return true
  }
}

public struct VGPUSubmission: Sendable {
  private let completion: VGPUCompletionCell

  package init(completion: VGPUCompletionCell) { self.completion = completion }

  public func settled(
    isolation: isolated (any Actor)? = #isolation
  ) async {
    await completion.wait()
  }
}

public enum VGPULifecycleState: String, Sendable {
  case open
  case closed
}

public final class VGPU {
  private let accessGate = VGPUAccessGate()
  private let stateLock = NSLock()
  private var state: VGPULifecycleState = .open
  package let backend: any VGPUCoreBackend
  package let observers: VGPUErrorObserverRegistry
  package let workLedger: VGPUWorkLedger
  private var children: [WeakContextChild] = []

  package init(backend: any VGPUCoreBackend) {
    self.backend = backend
    let observers = VGPUErrorObserverRegistry()
    self.observers = observers
    self.workLedger = VGPUWorkLedger(observers: observers)
  }

  public var lifecycleState: VGPULifecycleState {
    stateLock.lock()
    defer { stateLock.unlock() }
    return state
  }

  public func onError(
    _ handler: @escaping @isolated(any) @Sendable (VGPUError) -> Void
  ) -> @Sendable () -> Void {
    observers.subscribe(handler)
  }

  public func settled(
    isolation: isolated (any Actor)? = #isolation
  ) async {
    let snapshot = workLedger.snapshot()
    for completion in snapshot { await completion.wait() }
  }

  public func dispose() throws {
    try withAccess {
      stateLock.lock()
      guard state == .open else {
        stateLock.unlock()
        return
      }
      state = .closed
      let liveChildren = children.compactMap(\.value)
      children.removeAll(keepingCapacity: false)
      stateLock.unlock()
      for child in liveChildren { child.closeFromContext() }
    }
  }

  package func withOpenAccess<Result>(_ body: () throws -> Result) throws -> Result {
    try accessGate.withAccess {
      guard lifecycleState == .open else {
        throw VGPUError(code: .gpuDisposed, message: "The VGPU context is disposed.")
      }
      return try body()
    }
  }

  package func withAccess<Result>(_ body: () throws -> Result) throws -> Result {
    try accessGate.withAccess(body)
  }

  package func registerChild(_ child: any _VGPUContextChild) throws {
    try withOpenAccess {
      stateLock.lock()
      children.removeAll { $0.value == nil }
      children.append(WeakContextChild(child))
      stateLock.unlock()
    }
  }

  package var _pendingWorkCount: Int { workLedger.pendingCount }
  package var _settledSnapshotCount: UInt64 { workLedger.snapshotCount }
  package var _observerEvents: [VGPUObserverEvent] { observers.events }
}

@available(*, unavailable)
extension VGPU: Sendable {}

private final class WeakContextChild {
  weak var value: (any _VGPUContextChild)?

  init(_ value: any _VGPUContextChild) { self.value = value }
}

package func mapBackendError(_ error: any Error, operation: String) -> VGPUError {
  if let error = error as? VGPUError { return error }
  return VGPUError(
    code: .backendOperationFailed,
    message: "Backend operation '\(operation)' failed.",
    metadata: [
      "errorType": String(reflecting: type(of: error)),
      "operation": operation,
    ]
  )
}
