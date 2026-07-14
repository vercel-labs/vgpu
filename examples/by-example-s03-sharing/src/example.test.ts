import { expect, test } from "vitest";
import { CUBE, FLOOR, runSharingExample } from "./example.ts";

function pixel(bytes: Uint8Array, x: number, y: number, width: number): readonly number[] {
  const i = 4 * (y * width + x);
  return [bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]];
}

test("by-example §3 documents one shared user-owned uniform plus per-draw lib-owned params", () => {
  expect(CUBE).toContain("@binding(0) var<uniform> camera");
  expect(FLOOR).toContain("@binding(0) var<uniform> camera");
  expect(CUBE).toContain("@binding(1) var<uniform> params");
  expect(FLOOR).toContain("@binding(1) var<uniform> params");
});

test.skipIf(process.env.VGPU_DOCKER_TEST !== "1")("by-example §3 shared camera feeds two draws with mixed ownership params", async () => {
  const { gpu, target, camera } = await runSharingExample();
  try {
    const pixels = await target.read();
    const left = pixel(pixels, 3, 8, 16);
    const right = pixel(pixels, 12, 8, 16);
    expect(left[0]).toBeGreaterThan(180);
    expect(left[1]).toBeLessThan(40);
    expect(right[1]).toBeGreaterThan(180);
    expect(right[0]).toBeLessThan(40);
    expect(camera.size).toBe(16);
  } finally {
    gpu.dispose();
  }
});
