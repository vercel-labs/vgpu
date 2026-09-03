import BackendSPI

public enum VGPUError: Error {
  case backendUnavailable
  case capabilityUnavailable
}

public final class VGPU {
  package let backend: any CoreBackend

  package init(backend: any CoreBackend) {
    self.backend = backend
  }

  @inline(never)
  public func contextFingerprint() -> UInt64 {
    backend.coreFingerprint()
  }
}
