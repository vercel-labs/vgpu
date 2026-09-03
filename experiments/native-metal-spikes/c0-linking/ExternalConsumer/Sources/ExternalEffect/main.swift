import PhysicalMetalCore
import VGPUABI
import VGPUCore
import VGPURender
import VGPUResources

enum EffectProgram {
  static let descriptor = ProgramDescriptor(entryPoint: "fragmentMain")
}

let gpu = try VGPU.physicalMetal()
let buffer = try gpu.buffer(byteCount: 256)
let effect = gpu.effect(EffectProgram.self, descriptor: EffectProgram.descriptor)
print(buffer.backendID, try gpu.draw(effect))
