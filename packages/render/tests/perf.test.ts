import { describe, expect, test } from "vitest";
import { Device, createMockGPUDevice, type Texture } from "@vgpu/core";
import { gpuFrameTime, pixelDiff } from "@vgpu/render/perf";

describe("pixelDiff", () => {
  test("identical inputs report no difference", async () => {
    const got = await pixelDiff(new Uint8Array([1, 2, 3, 255]), new Uint8Array([1, 2, 3, 255]));
    expect(got.maxByte).toBe(0);
    expect(got.changedBytes).toBe(0);
    expect(got.changedFraction).toBe(0);
  });

  test("reports max + count of differing bytes", async () => {
    const got = await pixelDiff(new Uint8Array([10, 10, 10, 10]), new Uint8Array([10, 12, 10, 255]));
    expect(got.maxByte).toBe(245);
    expect(got.changedBytes).toBe(2);
    expect(got.totalBytes).toBe(4);
  });

  test("a length mismatch surfaces as a maximal difference", async () => {
    const got = await pixelDiff(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3, 4]));
    expect(got.maxByte).toBe(255);
  });
});

describe("gpuFrameTime", () => {
  test("wall-clock fallback reports one sample per measured frame", async () => {
    const device = new Device(createMockGPUDevice(), null);
    const indexes: number[] = [];

    const result = await gpuFrameTime(device, (_encoder, i) => indexes.push(i), { frames: 5, warmup: 2, batch: 2, forceWallClock: true });

    expect(result.method).toBe("wall-clock");
    expect(result.samples).toBe(5);
    expect(indexes).toEqual([0, 1, 0, 1, 2, 3, 4]);
    device.destroy();
  });
});
