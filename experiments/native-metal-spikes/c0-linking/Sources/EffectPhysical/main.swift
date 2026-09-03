import AppPrograms
import PhysicalMetalCore
import VGPUCore
import VGPURender
import VGPUResources

let gpu = try VGPU.physicalMetal()
let buffer = try gpu.buffer(byteCount: 256)
let effect = gpu.effect(EffectProgram.self, descriptor: EffectProgram.descriptor)
print(buffer.backendID, try gpu.draw(effect))
