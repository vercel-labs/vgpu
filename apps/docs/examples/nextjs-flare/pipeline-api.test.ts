import { expect, test } from "vitest";
import {
  getMockGPUDeviceInstrumentation,
  init,
  target,
  type Gpu,
} from "vgpu/mock";

import { FlarePipeline, rgbaRaster } from "./pipeline";

test("the flare initializes complete logo uniforms and preserves them during partial frame updates", async () => {
  const gpu = await init();
  let pipeline: FlarePipeline | undefined;
  try {
    const output = target(gpu, { size: [160, 90], format: "rgba8unorm" });
    pipeline = new FlarePipeline(gpu, output);
    const raster = rgbaRaster(new Uint8Array(8 * 8 * 4).fill(255), 8, 8);

    for (const size of [
      [160, 90],
      [200, 100],
    ] as const) {
      const placement = await pipeline.replace(size, 1, raster);
      expect(placement).toBeDefined();
      if (!placement) throw new Error("The flare did not bind its logo");
      pipeline.setFrameUniforms(placement, [0.3, 0.4], 7, 2, 0);
      pipeline.draw(true);
      await gpu.settled();

      expect(output.size).toEqual(size);
      expect(logoUniformFloats(gpu)).toEqual(
        [
          ...placement.logoCenter,
          ...placement.logoScale,
          3 / 8,
          3 / 8,
          1.1,
          0,
        ].map(Math.fround)
      );
    }
  } finally {
    pipeline?.dispose();
    gpu.dispose();
  }
});

function logoUniformFloats(gpu: Gpu): number[] {
  const buffers = new Set<GPUBuffer>();
  for (const descriptor of getMockGPUDeviceInstrumentation(gpu.device.gpu)
    .createBindGroupDescriptors)
    for (const { resource } of descriptor.entries)
      if (
        "buffer" in resource &&
        resource.buffer.label === "nextjs-flare-logo.params"
      )
        buffers.add(resource.buffer);
  expect(buffers.size).toBe(1);
  const buffer = [...buffers][0]!;
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
}
