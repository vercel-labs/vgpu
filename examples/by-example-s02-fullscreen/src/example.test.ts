import { expect, test } from "vitest";
import { runFullscreenExample } from "./example.ts";

test.skipIf(process.env.VGPU_DOCKER_TEST !== "1")("by-example §2 fullscreen pass renders explicit time", async () => {
  const { gpu, target } = await runFullscreenExample();
  try {
    const pixels = await target.read();
    expect(pixels[4 * (4 * 8 + 4) + 2]).toBeGreaterThan(245);
  } finally {
    gpu.dispose();
  }
});
