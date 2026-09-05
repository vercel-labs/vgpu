import ExternalGeneratedFixture
import VGPUABI
import VGPUCompute
import VGPUCore

func compileGeneratedSurface(
  gpu: VGPU,
  values: Values.Binding,
  output: VGPUStorage<UInt32>
) throws {
  let compute = try gpu.compute(
    InspectValues.self,
    bindings: .init(values: values, output: output)
  )
  try compute.set(\.values, to: values)
  _ = try compute.dispatch(x: 1)
}

print("cross-package/generated-compute")
