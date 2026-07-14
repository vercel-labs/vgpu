import { expect, test } from "vitest";
import { POST, runHdrPostExample, SOLID } from "./example.ts";

test("by-example §7 renders HDR scene then samples it with explicit texel size", () => {
  expect(SOLID).toContain("@fragment fn main");
  expect(POST).toContain("var src: texture_2d<f32>");
  expect(POST).toContain("texel: vec2f");
  expect(POST).toContain("textureLoad(src");
});

test.skipIf(process.env.VGPU_DOCKER_TEST !== "1")("by-example §7 HDR target feeds a post pass", async () => {
  const { gpu, output } = await runHdrPostExample();
  try {
    const pixels = await output.read();
    expect(pixels[1]).toBeGreaterThan(100);
    expect(pixels[2]).toBeGreaterThan(150);
  } finally {
    gpu.dispose();
  }
});
