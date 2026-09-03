import BackendSPI
import CapabilityPayloads
import Metal
import VGPUCore

package final class PhysicalMetalBackend: CoreBackend {
  package let device: any MTLDevice

  package init(device: any MTLDevice) {
    self.device = device
  }

  @inline(never)
  package func coreFingerprint() -> UInt64 {
    c0_core_payload() ^ UInt64(device.maxBufferLength)
  }
}

public extension VGPU {
  static func physicalMetal() throws -> VGPU {
    guard let device = MTLCreateSystemDefaultDevice() else {
      throw VGPUError.backendUnavailable
    }
    return VGPU(backend: PhysicalMetalBackend(device: device))
  }
}
