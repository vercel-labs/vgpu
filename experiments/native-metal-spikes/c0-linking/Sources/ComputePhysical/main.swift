import AppPrograms
import PhysicalMetalCore
import VGPUCompute
import VGPUCore
import VGPUResources

let gpu = try VGPU.physicalMetal()
let buffer = try gpu.buffer(byteCount: 4_096)
let program = gpu.compute(ComputeProgram.self, descriptor: ComputeProgram.descriptor)
print(buffer.backendID, try gpu.dispatch(program, groups: 16))
