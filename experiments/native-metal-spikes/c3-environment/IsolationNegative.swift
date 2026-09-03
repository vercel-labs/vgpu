struct ProbeError: Error, Sendable {}

struct Registry {
  func onError(
    _ handler: @escaping @isolated(any) @Sendable (ProbeError) -> Void
  ) -> @Sendable () -> Void {
    {}
  }
}

final class MutableBox {
  var value = 0
}

func rejectedCapture(_ registry: Registry) {
  let box = MutableBox()
  _ = registry.onError { _ in
    box.value += 1
  }
}
