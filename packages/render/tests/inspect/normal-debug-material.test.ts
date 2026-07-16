import { createMockAdapter } from "@vgpu/adapter-mock";

import { normalDebugMaterial } from "@vgpu/render/inspect";
import { expect, test, vi } from "vitest";

const VIEW_PROJECTION = new Float32Array([1, 0, 0, 0, 0, 2, 0, 0, 0, 0, 3, 0, 4, 5, 6, 1]);
const MODEL = new Float32Array([7, 0, 0, 0, 0, 8, 0, 0, 0, 0, 9, 0, 10, 11, 12, 1]);

test("normalDebugMaterial returns a triangle-list pipeline", async () => {
  const device = await createMockAdapter().requestDevice();
  const createRenderPipeline = vi.spyOn(device.gpu, "createRenderPipeline");

  normalDebugMaterial({ device });

  expect(createRenderPipeline).toHaveBeenCalledWith(expect.objectContaining({
    primitive: expect.objectContaining({ topology: "triangle-list", cullMode: "back", frontFace: "ccw" }),
    depthStencil: { format: "depth24plus", depthWriteEnabled: true, depthCompare: "less" },
  }));
  device.destroy();
});

test("normalDebugMaterial respects custom targetFormat", async () => {
  const device = await createMockAdapter().requestDevice();
  const createRenderPipeline = vi.spyOn(device.gpu, "createRenderPipeline");

  normalDebugMaterial({ device, targetFormat: "rgba8unorm-srgb" });

  expect(createRenderPipeline).toHaveBeenCalledWith(expect.objectContaining({
    fragment: expect.objectContaining({ targets: [expect.objectContaining({ format: "rgba8unorm-srgb" })] }),
  }));
  device.destroy();
});

test("normalDebugMaterial declares vertex shader entry vs_main and fragment fs_main", async () => {
  const device = await createMockAdapter().requestDevice();
  const createRenderPipeline = vi.spyOn(device.gpu, "createRenderPipeline");

  normalDebugMaterial({ device });

  expect(createRenderPipeline).toHaveBeenCalledWith(expect.objectContaining({
    vertex: expect.objectContaining({ entryPoint: "vs_main" }),
    fragment: expect.objectContaining({ entryPoint: "fs_main" }),
  }));
  device.destroy();
});

test("normalDebugMaterial writes a 128-byte uniform layout with matrices only", async () => {
  const device = await createMockAdapter().requestDevice();
  const material = normalDebugMaterial({ device });
  const buffer = device.createBuffer({ size: material.uniformByteSize, usage: ["uniform", "copy_dst"] });

  material.writeUniforms(buffer.gpu, 0, { viewProjectionMatrix: VIEW_PROJECTION, modelMatrix: MODEL });

  const bytes = await buffer.read(material.uniformByteSize);
  const floats = new Float32Array(bytes);
  expect(material.uniformByteSize).toBe(128);
  expect(Array.from(floats.slice(0, 16))).toEqual(Array.from(VIEW_PROJECTION));
  expect(Array.from(floats.slice(16, 32))).toEqual(Array.from(MODEL));
  device.destroy();
});
