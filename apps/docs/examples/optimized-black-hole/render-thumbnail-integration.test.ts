import { expect, test } from "vitest";
import { init, target } from "vgpu/mock";
import { uniformBindingFloats } from "../../test-support/mock-uniforms";

import { renderThumbnail } from "./render-thumbnail";

test("the optimized thumbnail captures complete uniforms for every frame", async () => {
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
    expect(uniformBindingFloats(gpu, "optimized-black-hole-bake")).toEqual([
      geometry,
    ]);
    expect(uniformBindingFloats(gpu, "optimized-black-hole-refine")).toEqual([
      geometry,
    ]);
    expect(uniformBindingFloats(gpu, "optimized-black-hole-shade", 0)).toEqual([
      [160, 90, 3.25, 9, 0, 0],
      [160, 90, 3.75, 9, 0, 0],
    ]);
  } finally {
    gpu.dispose();
  }
});
