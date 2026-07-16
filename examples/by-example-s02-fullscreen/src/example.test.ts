import { expect, test } from "vitest";
import { runFullscreenExample, WAVE } from "./example.ts";

test("by-example §2 uses explicit JS time/speed uniforms in a fragment-only fullscreen pass", () => {
  expect(WAVE).toContain("struct Params { time: f32, speed: f32 }");
  expect(WAVE).toContain("@fragment fn main");
  expect(WAVE).not.toContain("@vertex");
});

test.skipIf(process.env.VGPU_DOCKER_TEST !== "1")("by-example §2 fullscreen pass renders explicit time", async () => {
  const { gpu, target } = await runFullscreenExample();
  try {
    const pixels = await target.read();
    expect(pixels[4 * (4 * 8 + 4) + 2]).toBeGreaterThan(245);
  } finally {
    gpu.dispose();
  }
});
