import Foundation

public enum VGPULifecycleState: String, Sendable {
  case open
  case closed
}

public final class VGPU {
  private let kernel: ContextKernel

  package init(backend: any VGPULifecycleBackend) {
    self.kernel = ContextKernel(backend: backend)
  }

  public var lifecycleState: VGPULifecycleState {
    switch kernel.currentState {
    case .open: .open
    case .closed: .closed
    }
  }

  public func onError(
    _ handler: @escaping @isolated(any) @Sendable (VGPUError) -> Void
  ) -> @Sendable () -> Void {
    kernel.observerRegistry.subscribe(handler)
  }

  public func settled(
    isolation: isolated (any Actor)? = #isolation
  ) async {
    let snapshot = kernel.workLedger.snapshot()
    for completion in snapshot {
      await completion.wait()
    }
  }

  public func dispose() throws {
    try kernel.withAccess {
      kernel.close()
    }
  }

  package func _makeResource(label: String) throws -> VGPUResource {
    try kernel.withOpenAccess {
      do {
        let generation = try kernel.backend.allocateGeneration(label: label)
        let lifetime = kernel.makeLifetime(for: generation)
        return VGPUResource(
          kernel: kernel,
          generation: generation,
          lifetime: lifetime
        )
      } catch {
        throw mapBackendError(error, operation: "resource.allocate")
      }
    }
  }

  package func _withAccessForProbe<Result>(
    _ body: () throws -> Result
  ) throws -> Result {
    try kernel.withOpenAccess(body)
  }

  package var _pendingWorkCount: Int { kernel.workLedger.pendingCount }
  package var _settledSnapshotCount: UInt64 { kernel.workLedger.snapshotCount }
  package var _observerEvents: [VGPUObserverEvent] { kernel.observerRegistry.events }
  package var _registeredResourceCount: Int { kernel.registeredResourceCount }

  package func _setObserverBeforeStartHook(
    _ hook: (@Sendable (UInt64, UInt64) -> Void)?
  ) {
    kernel.observerRegistry.setBeforeStartHook(hook)
  }

  package func _submit(
    label: String,
    resources: [VGPUResource]
  ) throws -> VGPUSubmission {
    let registration = try kernel.withOpenAccess {
      var seen: Set<VGPUBackendGeneration> = []
      var generations: [VGPUBackendGeneration] = []
      var lifetimes: [GenerationLifetime] = []
      for resource in resources {
        guard resource.kernel === kernel else {
          throw VGPUError(
            code: .contextMismatch,
            message: "A submitted resource belongs to another VGPU context."
          )
        }
        guard seen.insert(resource.generation).inserted else { continue }
        generations.append(resource.generation)
        lifetimes.append(resource.lifetime)
      }
      let ticket = try kernel.registerWork(lifetimes: lifetimes)
      return (ticket: ticket, generations: generations)
    }
    startSubmission(
      backend: kernel.backend,
      label: label,
      generations: registration.generations,
      ticket: registration.ticket
    )
    return VGPUSubmission(completion: registration.ticket.completion)
  }

  package func _registerManualWork(
    resource: VGPUResource
  ) throws -> VGPUManualWork {
    try kernel.withOpenAccess {
      guard resource.kernel === kernel else {
        throw VGPUError(
          code: .contextMismatch,
          message: "A registered resource belongs to another VGPU context."
        )
      }
      return VGPUManualWork(
        ticket: try kernel.registerWork(lifetimes: [resource.lifetime])
      )
    }
  }
}

@available(*, unavailable)
extension VGPU: Sendable {}

public final class VGPUResource {
  fileprivate let kernel: ContextKernel
  fileprivate let generation: VGPUBackendGeneration
  fileprivate let lifetime: GenerationLifetime

  fileprivate init(
    kernel: ContextKernel,
    generation: VGPUBackendGeneration,
    lifetime: GenerationLifetime
  ) {
    self.kernel = kernel
    self.generation = generation
    self.lifetime = lifetime
  }

  public var lifecycleState: VGPULifecycleState {
    lifetime.isClosed ? .closed : .open
  }

  public func read(
    isolation: isolated (any Actor)? = #isolation
  ) async throws -> [UInt8] {
    // This complete registration happens synchronously before the first `await` below.
    let registration = try kernel.withOpenAccess {
      let ticket = try kernel.registerWork(lifetimes: [lifetime])
      return (ticket: ticket, generation: generation)
    }

    do {
      let bytes = try await kernel.backend.readGeneration(registration.generation)
      await registration.ticket.finish()
      return bytes
    } catch {
      let mapped = mapBackendError(error, operation: "resource.read")
      await registration.ticket.finish()
      throw mapped
    }
  }

  public func dispose() throws {
    try kernel.withAccess {
      lifetime.close()
    }
  }

  package func _submit(label: String) throws -> VGPUSubmission {
    let registration = try kernel.withOpenAccess {
      let ticket = try kernel.registerWork(lifetimes: [lifetime])
      return (ticket: ticket, generation: generation)
    }
    startSubmission(
      backend: kernel.backend,
      label: label,
      generations: [registration.generation],
      ticket: registration.ticket
    )
    return VGPUSubmission(completion: registration.ticket.completion)
  }

  package var _leaseCount: Int { lifetime.leaseCount }
}

@available(*, unavailable)
extension VGPUResource: Sendable {}

package struct VGPUManualWork: Sendable {
  private let ticket: WorkTicket

  init(ticket: WorkTicket) {
    self.ticket = ticket
  }

  package var submission: VGPUSubmission {
    VGPUSubmission(completion: ticket.completion)
  }

  package func finish(error: VGPUError?) async {
    await ticket.finish(error: error)
  }
}

private func startSubmission(
  backend: any VGPULifecycleBackend,
  label: String,
  generations: [VGPUBackendGeneration],
  ticket: WorkTicket
) {
  Task.detached { @Sendable in
    do {
      try await backend.execute(label: label, generations: generations)
      await ticket.finish()
    } catch {
      await ticket.finish(
        error: mapBackendError(error, operation: "submission.\(label)")
      )
    }
  }
}
