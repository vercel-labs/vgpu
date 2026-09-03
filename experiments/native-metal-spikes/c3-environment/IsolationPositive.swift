struct ProbeError: Error, Sendable {}

struct Registry {
  func onError(
    _ handler: @escaping @isolated(any) @Sendable (ProbeError) -> Void
  ) -> @Sendable () -> Void {
    {}
  }
}

struct Submission: Sendable {
  let id: Int

  func settled(
    isolation: isolated (any Actor)? = #isolation
  ) async {}
}

@MainActor
func subscribeOnMain(_ registry: Registry) {
  _ = registry.onError { _ in
    MainActor.assertIsolated()
  }
}

actor Renderer {
  private var resumed = false

  func handle(_ error: ProbeError) {}

  func subscribe(_ registry: Registry) {
    _ = registry.onError(handle)
  }

  func waitForSubmission(_ submission: Submission) async -> Bool {
    await submission.settled()
    resumed = true
    return resumed
  }
}

func sendAcrossActors(_ renderer: Renderer, submission: Submission) async -> Bool {
  await renderer.waitForSubmission(submission)
}
