import { expect, test } from "vitest";
import { runSharedUniformsExample, TINT, WAVE } from "./example.ts";

test("by-example §4 has two consumers wired for the same shared uniform layout", () => {
  expect(WAVE).toContain("struct Globals { time: f32, mouse: vec2f }");
  expect(TINT).toContain("struct Globals { time: f32, mouse: vec2f }");
  expect(WAVE).toContain("@binding(0) var<uniform> globals");
  expect(TINT).toContain("@binding(0) var<uniform> g");
});

test.skipIf(process.env.VGPU_DOCKER_TEST !== "1")("by-example §4 shared uniforms feed multiple consumers", async () => {
  const { gpu, target } = await runSharedUniformsExample();
  try {
    const pixels = await target.read();
    expect(pixels[0]).toBeGreaterThan(150);
  } finally {
    gpu.dispose();
  }
});
