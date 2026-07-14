import { expect, test } from "vitest";
import { runComputeExample } from "./example.ts";

test.skipIf(process.env.VGPU_DOCKER_TEST !== "1")("by-example §11 compute dispatch writes storage", async () => {
  const { gpu, dst } = await runComputeExample();
  try {
    const data = new Float32Array(await dst.read(16));
    expect(data[0]).toBeCloseTo(1);
    expect(data[1]).toBeLessThan(-2);
  } finally {
    gpu.dispose();
  }
});
