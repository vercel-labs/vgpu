import { expect, test } from "vitest";
import { runSharedUniformsExample } from "./example.ts";

test.skipIf(process.env.VGPU_DOCKER_TEST !== "1")("by-example §4 shared uniforms feed multiple consumers", async () => {
  const { gpu, target } = await runSharedUniformsExample();
  try {
    const pixels = await target.read();
    expect(pixels[0]).toBeGreaterThan(150);
  } finally {
    gpu.dispose();
  }
});
