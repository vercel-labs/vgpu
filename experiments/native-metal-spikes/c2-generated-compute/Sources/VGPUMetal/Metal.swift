import Metal
import VGPUCore
import _VGPUMetalCoreImpl

public enum VGPUMetalInitializationError: Error, Sendable {
  case noDevice
  case noCommandQueue
}

extension VGPU {
  public static func metal() throws -> VGPU {
    guard let device = MTLCreateSystemDefaultDevice() else {
      throw VGPUMetalInitializationError.noDevice
    }
    guard let commandQueue = device.makeCommandQueue() else {
      throw VGPUMetalInitializationError.noCommandQueue
    }
    return VGPU(backend: MetalBackend(device: device, commandQueue: commandQueue))
  }
}
