import UnifiedMetal
import VGPUCore

let gpu = try VGPU.unifiedMetal()
print(gpu.contextFingerprint())
