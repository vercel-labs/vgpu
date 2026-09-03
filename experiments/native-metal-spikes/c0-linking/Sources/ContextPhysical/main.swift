import PhysicalMetalCore
import VGPUCore

let gpu = try VGPU.physicalMetal()
print(gpu.contextFingerprint())
