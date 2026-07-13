import { describe, expect, test } from "vitest";
import { App } from "@vgpu/core";
import { createNodeAdapter } from "@vgpu/adapter-node";

describe.skipIf(process.env.VGPU_DOCKER_TEST !== "1")("adapter-node Docker GPU", () => {
  test("writes f32 buffer and reads it back byte-equal", async () => {
    const { device } = await App.create({ adapter: createNodeAdapter() });
    const data = new Float32Array([1, 2, 3, 4]);
    const buffer = device.createBuffer({ size: data.byteLength, usage: ["copy_dst", "copy_src", "storage"] });

    buffer.write(data);
    const readback = new Float32Array(await buffer.read(data.byteLength));

    expect(readback).toEqual(data);
    buffer.destroy();
    device.destroy();
  });

  test("node error scope captures validation error from invalid buffer creation", async () => {
    const { device } = await App.create({ adapter: createNodeAdapter() });
    device.pushErrorScope("validation");
    device.createBuffer({ size: 16, usage: [] });

    await expect(device.popErrorScope()).resolves.toMatchObject({ name: "ValidationError", code: "VGPU-CORE-INVALID-USAGE" });
    device.destroy();
  });

  test("node device destroy is idempotent", async () => {
    const { device } = await App.create({ adapter: createNodeAdapter() });

    device.destroy();
    device.destroy();

    expect(device.gpu).toBeDefined();
  });

  test("node .gpu escape hatch returns underlying GPUDevice", async () => {
    const { device } = await App.create({ adapter: createNodeAdapter() });

    expect(device.gpu).toBeDefined();
    expect(typeof device.gpu.createBuffer).toBe("function");
    device.destroy();
  });
});
