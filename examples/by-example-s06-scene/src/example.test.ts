import { expect, test } from "vitest";
import { runSceneExample } from "./example.ts";

test.skipIf(process.env.VGPU_DOCKER_TEST !== "1")("by-example §6 mesh draw renders with camera and light uniforms", async () => {
  const { gpu, target } = await runSceneExample();
  try {
    const pixels = await target.read();
    expect(pixels.some((value) => value > 20)).toBe(true);
  } finally {
    gpu.dispose();
  }
});
