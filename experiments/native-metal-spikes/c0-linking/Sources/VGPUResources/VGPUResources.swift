import BackendSPI
import VGPUCore

public struct VGPUBuffer: Sendable {
  public let backendID: UInt64
}

public extension VGPU {
  @inline(never)
  func buffer(byteCount: Int) throws -> VGPUBuffer {
    guard let resources = backend as? any ResourceBackend else {
      throw VGPUError.capabilityUnavailable
    }
    return VGPUBuffer(backendID: resources.makeBuffer(byteCount: byteCount))
  }
}
