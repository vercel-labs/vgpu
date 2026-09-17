import { expect, test } from "vitest";
import { init, target } from "vgpu/mock";
import { uniformBindingFloats } from "../../test-support/mock-uniforms";

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
      expect(uniformBindingFloats(gpu, "nextjs-flare-logo")).toEqual([
        [
          ...placement.logoCenter,
          ...placement.logoScale,
          3 / 8,
          3 / 8,
          1.1,
          0,
        ].map(Math.fround),
      ]);
    }
  } finally {
    pipeline?.dispose();
    gpu.dispose();
  }
});
