import { expect, test } from "vitest";
import { runBundlesExample } from "./example.ts";

test.skipIf(process.env.VGPU_DOCKER_TEST !== "1")("by-example §9 bundle replays with in-place uniform updates", async () => {
  const { gpu, target } = await runBundlesExample();
  try {
    const pixels = await target.read();
    expect(pixels[0]).toBeGreaterThan(100);
  } finally {
    gpu.dispose();
  }
});
