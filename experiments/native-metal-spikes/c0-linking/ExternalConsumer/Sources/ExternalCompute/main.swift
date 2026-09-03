import PhysicalMetalCore
import VGPUABI
import VGPUCompute
import VGPUCore
import VGPUResources

enum ComputeProgram {
  static let descriptor = ProgramDescriptor(entryPoint: "computeMain")
}

let gpu = try VGPU.physicalMetal()
let buffer = try gpu.buffer(byteCount: 4_096)
let program = gpu.compute(ComputeProgram.self, descriptor: ComputeProgram.descriptor)
print(buffer.backendID, try gpu.dispatch(program, groups: 16))
