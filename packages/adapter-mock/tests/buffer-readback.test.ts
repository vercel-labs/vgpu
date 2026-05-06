import { expect, test } from "vitest";
import { App } from "@vgpu/core";
import { createMockAdapter } from "@vgpu/adapter-mock";

test("adapter-mock writes f32 buffer and reads it back byte-equal", async () => {
  const { device } = await App.create({ adapter: createMockAdapter() });
  const data = new Float32Array([1, 2, 3, 4]);
  const buffer = device.createBuffer({ size: data.byteLength, usage: ["copy_dst", "copy_src", "storage"] });

  buffer.write(data);
  const readback = new Float32Array(await buffer.read(data.byteLength));

  expect(readback).toEqual(data);
  buffer.destroy();
  device.destroy();
});

test("adapter-mock error scope captures validation error", async () => {
  const { device } = await App.create({ adapter: createMockAdapter() });
  device.pushErrorScope("validation");
  device.createBuffer({ size: 16, usage: [] });

  await expect(device.popErrorScope()).resolves.toMatchObject({ name: "ValidationError", code: "VGPU-CORE-INVALID-USAGE" });
  device.destroy();
});

test("adapter-mock device destroy is idempotent", async () => {
  const { device } = await App.create({ adapter: createMockAdapter() });

  device.destroy();
  device.destroy();

  expect(device.gpu).toBeDefined();
});

test("adapter-mock exposes .gpu escape hatch", async () => {
  const { device } = await App.create({ adapter: createMockAdapter() });

  expect(device.gpu).toBeDefined();
  expect(typeof device.gpu.createBuffer).toBe("function");
  device.destroy();
});
