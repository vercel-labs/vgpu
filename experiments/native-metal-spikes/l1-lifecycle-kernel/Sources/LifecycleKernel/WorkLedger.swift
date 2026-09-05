import Foundation

final class GenerationLifetime: @unchecked Sendable {
  private enum State {
    case open
    case closed
  }

  private let lock = NSLock()
  private let releaseGeneration: @Sendable () -> Void
  private var state: State = .open
  private var activeLeaseCount = 0
  private var didReleaseGeneration = false

  init(releaseGeneration: @escaping @Sendable () -> Void) {
    self.releaseGeneration = releaseGeneration
  }

  var isClosed: Bool {
    lock.withCriticalRegion {
      if case .closed = state { return true }
      return false
    }
  }

  var leaseCount: Int {
    lock.withCriticalRegion { activeLeaseCount }
  }

  func acquireLease() throws -> GenerationLease {
    try lock.withCriticalRegion {
      guard case .open = state else {
        throw VGPUError(
          code: .resourceDisposed,
          message: "The resource generation is already closed."
        )
      }
      activeLeaseCount += 1
      return GenerationLease(lifetime: self)
    }
  }

  func close() {
    let shouldRelease = lock.withCriticalRegion {
      guard case .open = state else { return false }
      state = .closed
      return claimReleaseIfReady()
    }
    if shouldRelease {
      releaseGeneration()
    }
  }

  fileprivate func releaseLease() {
    let shouldRelease = lock.withCriticalRegion {
      precondition(activeLeaseCount > 0)
      activeLeaseCount -= 1
      return claimReleaseIfReady()
    }
    if shouldRelease {
      releaseGeneration()
    }
  }

  private func claimReleaseIfReady() -> Bool {
    guard
      case .closed = state,
      activeLeaseCount == 0,
      !didReleaseGeneration
    else {
      return false
    }
    didReleaseGeneration = true
    return true
  }

  deinit {
    close()
  }
}

/// Intentionally module-internal: public callers can retain only the resource or a submission
/// token, never the native generation lease itself.
final class GenerationLease: @unchecked Sendable {
  private let lock = NSLock()
  private var lifetime: GenerationLifetime?

  fileprivate init(lifetime: GenerationLifetime) {
    self.lifetime = lifetime
  }

  func release() {
    let released = lock.withCriticalRegion { () -> GenerationLifetime? in
      defer { lifetime = nil }
      return lifetime
    }
    released?.releaseLease()
  }

  deinit {
    release()
  }
}

final class WorkTicket: @unchecked Sendable {
  let id: UInt64
  let completion: CompletionCell

  private let lock = NSLock()
  private let ledger: WorkLedger
  private let observerRegistry: ErrorObserverRegistry
  private var leases: [GenerationLease]
  private var didFinish = false

  init(
    id: UInt64,
    completion: CompletionCell,
    ledger: WorkLedger,
    observerRegistry: ErrorObserverRegistry,
    leases: [GenerationLease]
  ) {
    self.id = id
    self.completion = completion
    self.ledger = ledger
    self.observerRegistry = observerRegistry
    self.leases = leases
  }

  func finish(error: VGPUError? = nil) async {
    let releasedLeases = lock.withCriticalRegion { () -> [GenerationLease]? in
      guard !didFinish else { return nil }
      didFinish = true
      defer { leases.removeAll(keepingCapacity: false) }
      return leases
    }
    guard let releasedLeases else { return }

    for lease in releasedLeases {
      lease.release()
    }
    if let error {
      await observerRegistry.publish(error)
    }
    ledger.complete(id: id)
  }
}

final class WorkLedger: @unchecked Sendable {
  private let lock = NSLock()
  private let observerRegistry: ErrorObserverRegistry
  private var nextID: UInt64 = 1
  private var pending: [UInt64: CompletionCell] = [:]
  private var snapshotCounter: UInt64 = 0

  init(observerRegistry: ErrorObserverRegistry) {
    self.observerRegistry = observerRegistry
  }

  func register(leases: [GenerationLease]) -> WorkTicket {
    lock.withCriticalRegion {
      let id = nextID
      nextID += 1
      let completion = CompletionCell()
      pending[id] = completion
      return WorkTicket(
        id: id,
        completion: completion,
        ledger: self,
        observerRegistry: observerRegistry,
        leases: leases
      )
    }
  }

  func snapshot() -> [CompletionCell] {
    lock.withCriticalRegion {
      snapshotCounter += 1
      return pending.keys.sorted().compactMap { pending[$0] }
    }
  }

  var pendingCount: Int {
    lock.withCriticalRegion { pending.count }
  }

  var snapshotCount: UInt64 {
    lock.withCriticalRegion { snapshotCounter }
  }

  fileprivate func complete(id: UInt64) {
    let completion = lock.withCriticalRegion { pending.removeValue(forKey: id) }
    completion?.resolve()
  }
}

public struct VGPUSubmission: Sendable {
  private let completion: CompletionCell

  init(completion: CompletionCell) {
    self.completion = completion
  }

  public func settled(
    isolation: isolated (any Actor)? = #isolation
  ) async {
    await completion.wait()
  }

  package var _isSettled: Bool { completion.isCompleted }
}

final class ContextKernel: @unchecked Sendable {
  enum State: Equatable, Sendable {
    case open
    case closed
  }

  let backend: any VGPULifecycleBackend
  let observerRegistry: ErrorObserverRegistry
  let workLedger: WorkLedger

  private let accessGate = VGPUAccessGate()
  private let stateLock = NSLock()
  private var state: State = .open
  private var resources: [WeakGenerationLifetime] = []

  init(backend: any VGPULifecycleBackend) {
    self.backend = backend
    let observerRegistry = ErrorObserverRegistry()
    self.observerRegistry = observerRegistry
    self.workLedger = WorkLedger(observerRegistry: observerRegistry)
  }

  var currentState: State {
    stateLock.withCriticalRegion { state }
  }

  func withOpenAccess<Result>(_ body: () throws -> Result) throws -> Result {
    try accessGate.withAccess {
      guard currentState == .open else {
        throw VGPUError(
          code: .gpuDisposed,
          message: "The VGPU context is disposed."
        )
      }
      return try body()
    }
  }

  func withAccess<Result>(_ body: () throws -> Result) throws -> Result {
    try accessGate.withAccess(body)
  }

  func makeLifetime(for generation: VGPUBackendGeneration) -> GenerationLifetime {
    let backend = backend
    let lifetime = GenerationLifetime {
      backend.releaseGeneration(generation)
    }
    stateLock.withCriticalRegion {
      precondition(state == .open)
      resources.removeAll { $0.value == nil }
      resources.append(WeakGenerationLifetime(lifetime))
    }
    return lifetime
  }

  func registerWork(lifetimes: [GenerationLifetime]) throws -> WorkTicket {
    var leases: [GenerationLease] = []
    leases.reserveCapacity(lifetimes.count)
    do {
      for lifetime in lifetimes {
        leases.append(try lifetime.acquireLease())
      }
    } catch {
      for lease in leases {
        lease.release()
      }
      throw error
    }
    return workLedger.register(leases: leases)
  }

  func close() {
    let resourcesToClose = stateLock.withCriticalRegion { () -> [GenerationLifetime]? in
      guard state == .open else { return nil }
      state = .closed
      let live = resources.compactMap(\.value)
      resources.removeAll(keepingCapacity: false)
      return live
    }
    guard let resourcesToClose else { return }
    for resource in resourcesToClose {
      resource.close()
    }
  }

  var registeredResourceCount: Int {
    stateLock.withCriticalRegion {
      resources.removeAll { $0.value == nil }
      return resources.count
    }
  }
}

private final class WeakGenerationLifetime {
  weak var value: GenerationLifetime?

  init(_ value: GenerationLifetime) {
    self.value = value
  }
}
