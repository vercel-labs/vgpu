import BackendSPI
import CapabilityPayloads
import Metal
import VGPUCore

final class UnifiedMetalBackend: CoreBackend {
  let device: any MTLDevice

  init(device: any MTLDevice) {
    self.device = device
  }

  @inline(never)
  func coreFingerprint() -> UInt64 {
    c0_core_payload() ^ UInt64(device.maxBufferLength)
  }
}

public extension VGPU {
  static func unifiedMetal() throws -> VGPU {
    guard let device = MTLCreateSystemDefaultDevice() else {
      throw VGPUError.backendUnavailable
    }
    return VGPU(backend: UnifiedMetalBackend(device: device))
  }
}
