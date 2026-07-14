import { expect, test } from "vitest";
import { runSchedulingResizeExample } from "./example.ts";

test.skipIf(process.env.VGPU_DOCKER_TEST !== "1")("by-example §12 on-demand frames and explicit resize are deterministic", async () => {
  const { gpu, target } = await runSchedulingResizeExample();
  try {
    expect(target.size).toEqual([8, 8]);
    const pixels = await target.read();
    expect(pixels.length).toBe(8 * 8 * 4);
  } finally {
    gpu.dispose();
  }
});
