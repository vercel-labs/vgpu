import { expect, test } from "vitest";
import { LIT_WGSL, runSceneExample } from "./example.ts";

test("by-example §6 declares mesh vertex inputs plus camera/model/light uniforms", () => {
  expect(LIT_WGSL).toContain("@location(0) position: vec3f");
  expect(LIT_WGSL).toContain("@location(1) normal: vec3f");
  expect(LIT_WGSL).toContain("var<uniform> camera");
  expect(LIT_WGSL).toContain("var<uniform> model");
  expect(LIT_WGSL).toContain("var<uniform> light");
});

test.skipIf(process.env.VGPU_DOCKER_TEST !== "1")("by-example §6 mesh draw renders with camera and light uniforms", async () => {
  const { gpu, target } = await runSceneExample();
  try {
    const pixels = await target.read();
    expect(pixels.some((value) => value > 20)).toBe(true);
  } finally {
    gpu.dispose();
  }
});
