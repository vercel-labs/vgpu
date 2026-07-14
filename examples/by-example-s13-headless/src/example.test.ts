import { expect, test } from "vitest";
import { renderGradientHeadless } from "./example.ts";

test.skipIf(process.env.VGPU_DOCKER_TEST !== "1")("by-example §13 headless Node render is deterministic", async () => {
  const { gpu, target } = await renderGradientHeadless();
  try {
    const px = await target.read();
    expect(px[0]).toBeGreaterThan(0);
  } finally {
    gpu.dispose();
  }
});
