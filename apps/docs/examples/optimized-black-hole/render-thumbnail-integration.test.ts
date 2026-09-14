import { expect, test } from "vitest";
import {
  getMockGPUDeviceInstrumentation,
  init,
  target,
  type Gpu,
} from "vgpu/mock";

import { renderThumbnail } from "./render-thumbnail";

test("the optimized thumbnail initializes complete uniforms with its camera and frame state", async () => {
  const gpu = await init();
  try {
    const output = target(gpu, { size: [160, 90], format: "rgba8unorm" });
    await renderThumbnail(gpu, output, {
      time: 3.25,
      dt: 0.5,
      warmupFrames: 2,
    });

    const geometry = [160, 90, 0, 0.16, 13.5, 9, 3, 0.8, 0.3, -0.27].map(
      Math.fround
    );
    expect(bindingFloats(gpu, ".bake")).toEqual([geometry]);
    expect(bindingFloats(gpu, ".refine")).toEqual([geometry]);
    expect(bindingFloats(gpu, ".shade")).toEqual([[160, 90, 3.75, 9, 0, 0]]);
  } finally {
    gpu.dispose();
  }
});

function bindingFloats(gpu: Gpu, suffix: string): number[][] {
  const buffers = new Set<GPUBuffer>();
  for (const descriptor of getMockGPUDeviceInstrumentation(gpu.device.gpu)
    .createBindGroupDescriptors)
    for (const { resource } of descriptor.entries)
      if ("buffer" in resource && resource.buffer.label.endsWith(suffix))
        buffers.add(resource.buffer);
  return [...buffers].map((buffer) => {
    if (
      !("__vgpuMockBytes" in buffer) ||
      !(buffer.__vgpuMockBytes instanceof Uint8Array)
    )
      throw new Error(
        "The public mock backend did not expose packed buffer bytes"
      );
    const bytes = buffer.__vgpuMockBytes;
    return [
      ...new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4),
    ];
  });
}
