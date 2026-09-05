import Foundation

extension NSLock {
  func withCriticalRegion<Result>(
    _ body: () throws -> Result
  ) rethrows -> Result {
    lock()
    defer { unlock() }
    return try body()
  }
}

final class VGPUAccessGate: @unchecked Sendable {
  private let lock = NSLock()
  private let threadDictionaryKey = "vgpu.lifecycle.access.\(UUID().uuidString)"
  private var isClaimed = false

  func withAccess<Result>(_ body: () throws -> Result) throws -> Result {
    let dictionary = Thread.current.threadDictionary
    if let depth = dictionary[threadDictionaryKey] as? Int, depth > 0 {
      dictionary[threadDictionaryKey] = depth + 1
      defer {
        dictionary[threadDictionaryKey] = depth
      }
      return try body()
    }

    let claimed = lock.withCriticalRegion {
      guard !isClaimed else { return false }
      isClaimed = true
      return true
    }
    guard claimed else {
      throw VGPUError(
        code: .concurrentAccess,
        message: "The VGPU object graph is already in use by another owner."
      )
    }

    dictionary[threadDictionaryKey] = 1
    defer {
      dictionary.removeObject(forKey: threadDictionaryKey)
      lock.withCriticalRegion { isClaimed = false }
    }
    return try body()
  }
}

final class CompletionCell: @unchecked Sendable {
  private let lock = NSLock()
  private var completed = false
  private var waiters: [CheckedContinuation<Void, Never>] = []

  var isCompleted: Bool {
    lock.withCriticalRegion { completed }
  }

  func wait() async {
    await withCheckedContinuation { continuation in
      let shouldResume = lock.withCriticalRegion {
        if completed { return true }
        waiters.append(continuation)
        return false
      }
      if shouldResume {
        continuation.resume()
      }
    }
  }

  func resolve() {
    let continuations = lock.withCriticalRegion { () -> [CheckedContinuation<Void, Never>] in
      guard !completed else { return [] }
      completed = true
      defer { waiters.removeAll(keepingCapacity: false) }
      return waiters
    }
    for continuation in continuations {
      continuation.resume()
    }
  }
}
