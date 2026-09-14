import type { MetalPackageInput } from "../src/index.ts";

// Handwritten MSL isolates generated compute binding helpers, not WGSL translation.
export const computeMSL = `#include <metal_stdlib>
using namespace metal;
kernel void count_main(device const uint* values [[buffer(0)]], device uint* output [[buffer(1)]]) {
  output[0] = values[0];
}
`;

export function computePackageInput(
  library: Uint8Array = new Uint8Array([1, 2, 3])
) {
  return {
    moduleName: "AppShaders",
    library,
    programs: [
      {
        name: "Count",
        functions: { compute: "count_main" },
        compute: {
          workgroupSize: { x: 1, y: 1, z: 1 },
          storage: [
            {
              name: "values",
              access: "read",
              minimumBindingSize: 4,
              alignment: 4,
              runtimeSized: false,
              slots: [{ stage: "compute", index: 0 }],
            },
            {
              name: "output",
              access: "read_write",
              minimumBindingSize: 4,
              alignment: 4,
              runtimeSized: false,
              slots: [{ stage: "compute", index: 1 }],
            },
          ],
          internalData: [],
        },
      },
    ],
  } as const satisfies MetalPackageInput;
}

export const sizeTableMSL = `#include <metal_stdlib>
using namespace metal;
struct Immediate { uint zero; uint valuesSize; };
kernel void count_main(device const uint* values [[buffer(0)]], device uint* output [[buffer(1)]], constant Immediate& immediate [[buffer(30)]]) {
  uint count = (immediate.valuesSize - 4u) / 12u;
  output[0] = count;
  output[1] = count > 0u ? values[1u + (count - 1u) * 3u + 2u] : 0u;
}
`;

export function sizeTablePackageInput(
  library: Uint8Array = new Uint8Array([1, 2, 3])
): MetalPackageInput {
  const input = computePackageInput(library);
  const program = input.programs[0];
  return {
    ...input,
    programs: [
      {
        ...program,
        compute: {
          ...program.compute,
          storage: [
            {
              ...program.compute.storage[0],
              minimumBindingSize: 16,
              runtimeSized: true,
            },
            { ...program.compute.storage[1], minimumBindingSize: 8 },
          ],
          internalData: [
            {
              kind: "storage-buffer-sizes",
              slot: { stage: "compute", index: 30 },
              immediateDataLayoutModel: "vgpu-metal-immediate-data-layout-v1",
              storageBufferSizeModel:
                "vgpu-metal-slot-indexed-storage-buffer-byte-sizes-v1",
              byteOffset: 4,
            },
          ],
        },
      },
    ],
  };
}

export const computeSetup = `import Metal
import AppShaders
let device = MTLCreateSystemDefaultDevice()!
let count = try Count.load(device: device)
let pipeline = try device.makeComputePipelineState(function: count.compute)
let queue = device.makeCommandQueue()!
@MainActor func dispatch(_ encode: (any MTLComputeCommandEncoder) throws -> Void) throws {
  let command = queue.makeCommandBuffer()!
  let encoder = command.makeComputeCommandEncoder()!
  encoder.setComputePipelineState(pipeline)
  try encode(encoder)
  encoder.dispatchThreadgroups(MTLSize(width: 1, height: 1, depth: 1), threadsPerThreadgroup: Count.workgroupSize)
  encoder.endEncoding()
  command.commit()
  command.waitUntilCompleted()
  if let error = command.error { throw error }
  precondition(command.status == .completed)
}
`;
