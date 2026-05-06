import { expect, test } from "vitest";
import { App } from "@vgpu/core";
import { createNodeAdapter } from "@vgpu/adapter-node";

test("s1 › writes f32 buffer and reads it back byte-equal in Node Docker", async () => {
  const { device } = await App.create({ adapter: createNodeAdapter() });
  const data = new Float32Array([1, 2, 3, 4]);
  const buffer = device.createBuffer({ size: data.byteLength, usage: ["copy_dst", "copy_src", "storage"] });

  buffer.write(data);
  const readback = new Float32Array(await buffer.read(data.byteLength));

  expect(readback).toEqual(data);
  buffer.destroy();
  device.destroy();
});

test("s1 › node error scope captures validation error from invalid buffer creation", async () => {
  const { device } = await App.create({ adapter: createNodeAdapter() });
  device.pushErrorScope("validation");
  device.createBuffer({ size: 16, usage: [] });

  await expect(device.popErrorScope()).resolves.toMatchObject({ name: "ValidationError", code: "VGPU-CORE-INVALID-USAGE" });
  device.destroy();
});

test("s1 › node device destroy is idempotent", async () => {
  const { device } = await App.create({ adapter: createNodeAdapter() });

  device.destroy();
  device.destroy();

  expect(device.gpu).toBeDefined();
});

test("s1 › node .gpu escape hatch returns underlying GPUDevice", async () => {
  const { device } = await App.create({ adapter: createNodeAdapter() });

  expect(device.gpu).toBeDefined();
  expect(typeof device.gpu.createBuffer).toBe("function");
  device.destroy();
});
