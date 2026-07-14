import { expect, test } from "vitest";
import { POST, runSchedulingResizeExample } from "./example.ts";

test("by-example §12 shader consumes explicit texel size rather than implicit globals", () => {
  expect(POST).toContain("texel: vec2f");
  expect(POST).toContain("params.texel");
});

test.skipIf(process.env.VGPU_DOCKER_TEST !== "1")("by-example §12 explicit resize updates rendered texelSize", async () => {
  const { gpu, target } = await runSchedulingResizeExample();
  try {
    expect(target.size).toEqual([8, 8]);
    const pixels = await target.read();
    expect(pixels.length).toBe(8 * 8 * 4);
    expect(pixels[0]).toBeGreaterThanOrEqual(30);
    expect(pixels[0]).toBeLessThanOrEqual(34);
    expect(pixels[1]).toBeGreaterThanOrEqual(30);
    expect(pixels[1]).toBeLessThanOrEqual(34);
    expect(pixels[2]).toBeGreaterThanOrEqual(126);
    expect(pixels[2]).toBeLessThanOrEqual(129);
  } finally {
    gpu.dispose();
  }
});
