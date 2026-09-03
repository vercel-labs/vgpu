struct Submission: Sendable {
  let id: Int

  func settled(
    isolation: isolated (any Actor)? = #isolation
  ) async {
    await Task.yield()
  }
}

actor Renderer {
  private var resumeCount = 0

  func waitForSubmission(_ submission: Submission) async -> Int {
    await submission.settled()
    resumeCount += 1
    return resumeCount
  }
}

@main
struct IsolationRuntimeProbe {
  static func main() async {
    let renderer = Renderer()
    let count = await renderer.waitForSubmission(Submission(id: 1))
    print("resumeCount=\(count)")
  }
}
