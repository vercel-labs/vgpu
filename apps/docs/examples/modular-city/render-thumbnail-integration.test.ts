import { describe, expect, it } from "vitest";
import { init, target } from "vgpu/mock";

import { renderThumbnail } from "./render-thumbnail";

describe("modular-city thumbnail integration", () => {
  it("builds every draw (shadow, color, outline, selection mask, ghost, pick, ground, present) and renders on the mock adapter", async () => {
    const gpu = await init();
    try {
      const output = target(gpu, { size: [160, 90], format: "rgba8unorm" });
      await expect(renderThumbnail(gpu, output, { warmupFrames: 2 })).resolves.toBeUndefined();
    } finally {
      gpu.dispose();
    }
  });
});
