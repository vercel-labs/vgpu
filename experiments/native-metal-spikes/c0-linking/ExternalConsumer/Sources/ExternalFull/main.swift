import PhysicalMetalCore
import VGPUABI
import VGPUCompute
import VGPUCore
import VGPURender
import VGPUResources

enum EffectProgram {
  static let descriptor = ProgramDescriptor(entryPoint: "fragmentMain")
}

enum ComputeProgram {
  static let descriptor = ProgramDescriptor(entryPoint: "computeMain")
}

let gpu = try VGPU.physicalMetal()
let buffer = try gpu.buffer(byteCount: 4_096)
let effect = gpu.effect(EffectProgram.self, descriptor: EffectProgram.descriptor)
let compute = gpu.compute(ComputeProgram.self, descriptor: ComputeProgram.descriptor)
print(
  buffer.backendID,
  try gpu.draw(effect),
  try gpu.dispatch(compute, groups: 16)
)
