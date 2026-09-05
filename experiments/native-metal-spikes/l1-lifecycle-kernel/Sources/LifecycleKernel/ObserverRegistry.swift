import Foundation

package enum VGPUObserverEvent: Equatable, Sendable {
  case published(publication: UInt64, code: VGPUErrorCode)
  case enqueued(publication: UInt64, subscription: UInt64)
  case delivered(publication: UInt64, subscription: UInt64)
  case skipped(publication: UInt64, subscription: UInt64)
  case startRejected(publication: UInt64, subscription: UInt64)
  case unobserved(publication: UInt64, code: VGPUErrorCode)
}

private struct ErrorEnvelope: Sendable {
  let publication: UInt64
  let error: VGPUError
}

private struct QueuedDelivery: Sendable {
  let envelope: ErrorEnvelope
  let completion: CompletionCell
}

private final class ErrorSubscription: @unchecked Sendable {
  let id: UInt64

  private let lock = NSLock()
  private let handler: @isolated(any) @Sendable (VGPUError) -> Void
  private let record: @Sendable (VGPUObserverEvent) -> Void
  private let beforeStart: @Sendable (UInt64, UInt64) -> Void
  private var active = true
  private var current: QueuedDelivery?
  private var handlerStarted = false
  private var queued: [QueuedDelivery] = []

  init(
    id: UInt64,
    handler: @escaping @isolated(any) @Sendable (VGPUError) -> Void,
    record: @escaping @Sendable (VGPUObserverEvent) -> Void,
    beforeStart: @escaping @Sendable (UInt64, UInt64) -> Void
  ) {
    self.id = id
    self.handler = handler
    self.record = record
    self.beforeStart = beforeStart
  }

  func deactivate() -> [QueuedDelivery] {
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

  func resolveInvalidated(_ invalidated: [QueuedDelivery]) {
    for delivery in invalidated {
      record(.skipped(publication: delivery.envelope.publication, subscription: id))
      delivery.completion.resolve()
    }
  }

  func enqueue(_ envelope: ErrorEnvelope) -> CompletionCell {
    let completion = CompletionCell()
    let delivery = QueuedDelivery(envelope: envelope, completion: completion)
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
      record(.skipped(publication: envelope.publication, subscription: id))
      completion.resolve()
      return completion
    }
    if shouldStart {
      start(delivery)
    }
    return completion
  }

  private func start(_ delivery: QueuedDelivery) {
    Task { @Sendable in
      beforeStart(delivery.envelope.publication, id)
      await deliver(
        delivery,
        isolation: handler.isolation
      )
    }
  }

  private func deliver(
    _ delivery: QueuedDelivery,
    isolation: isolated (any Actor)?
  ) async {
    guard claimHandlerStart(delivery) else {
      record(
        .startRejected(
          publication: delivery.envelope.publication,
          subscription: id
        )
      )
      return
    }
    await handler(delivery.envelope.error)
    record(.delivered(publication: delivery.envelope.publication, subscription: id))
    delivery.completion.resolve()
    finishCurrentDelivery(delivery)
  }

  private func claimHandlerStart(_ delivery: QueuedDelivery) -> Bool {
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

  private func finishCurrentDelivery(_ delivery: QueuedDelivery) {
    let next = lock.withCriticalRegion { () -> QueuedDelivery? in
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
    if let next {
      start(next)
    }
  }
}

private actor ErrorPublicationLane {
  private var nextPublication: UInt64 = 1

  func publish(_ error: VGPUError, through registry: ErrorObserverRegistry) async {
    let publication = nextPublication
    nextPublication += 1
    let envelope = ErrorEnvelope(publication: publication, error: error)
    let observers = registry.preparePublication(
      publication: publication,
      code: error.code
    )

    guard !observers.isEmpty else {
      registry.record(.unobserved(publication: publication, code: error.code))
      return
    }

    var completions: [CompletionCell] = []
    completions.reserveCapacity(observers.count)
    for observer in observers {
      registry.record(.enqueued(publication: publication, subscription: observer.id))
      completions.append(observer.enqueue(envelope))
    }
    for completion in completions {
      await completion.wait()
    }
  }
}

final class ErrorObserverRegistry: @unchecked Sendable {
  private let lock = NSLock()
  private let publicationLane = ErrorPublicationLane()
  private var nextSubscription: UInt64 = 1
  private var subscriptions: [UInt64: ErrorSubscription] = [:]
  private var order: [UInt64] = []
  private var recordedEvents: [VGPUObserverEvent] = []
  private var beforeStartHook: (@Sendable (UInt64, UInt64) -> Void)?

  func subscribe(
    _ handler: @escaping @isolated(any) @Sendable (VGPUError) -> Void
  ) -> @Sendable () -> Void {
    let subscription = lock.withCriticalRegion { () -> ErrorSubscription in
      let id = nextSubscription
      nextSubscription += 1
      let subscription = ErrorSubscription(
        id: id,
        handler: handler,
        record: { [weak self] event in self?.record(event) },
        beforeStart: { [weak self] publication, subscription in
          self?.runBeforeStartHook(
            publication: publication,
            subscription: subscription
          )
        }
      )
      subscriptions[id] = subscription
      order.append(id)
      return subscription
    }

    return { [weak self, weak subscription] in
      guard let self, let subscription else { return }
      self.unsubscribe(subscription)
    }
  }

  func publish(_ error: VGPUError) async {
    await publicationLane.publish(error, through: self)
  }

  var events: [VGPUObserverEvent] {
    lock.withCriticalRegion { recordedEvents }
  }

  func setBeforeStartHook(
    _ hook: (@Sendable (UInt64, UInt64) -> Void)?
  ) {
    lock.withCriticalRegion { beforeStartHook = hook }
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

  private func runBeforeStartHook(
    publication: UInt64,
    subscription: UInt64
  ) {
    let hook = lock.withCriticalRegion { beforeStartHook }
    hook?(publication, subscription)
  }

  private func unsubscribe(_ subscription: ErrorSubscription) {
    let invalidated = lock.withCriticalRegion { () -> [QueuedDelivery] in
      guard subscriptions.removeValue(forKey: subscription.id) != nil else {
        return []
      }
      order.removeAll { $0 == subscription.id }
      return subscription.deactivate()
    }
    subscription.resolveInvalidated(invalidated)
  }
}
