import { createMockAdapter } from "@vgpu/adapter-mock";
import { App } from "@vgpu/core";
import { Mesh } from "@vgpu/render";
import { meshToWireframe, wireframeMaterial } from "@vgpu/render/inspect";
import { expect, test, vi } from "vitest";

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

test("wireframeMaterial returns a pipeline configured for line-list topology", async () => {
  const { device } = await App.create({ adapter: createMockAdapter() });
  const createRenderPipeline = vi.spyOn(device.gpu, "createRenderPipeline");

  wireframeMaterial({ device });

  expect(createRenderPipeline).toHaveBeenCalledWith(expect.objectContaining({
    primitive: expect.objectContaining({ topology: "line-list", cullMode: "none" }),
  }));
  device.destroy();
});

test("wireframeMaterial respects custom color", async () => {
  const { device } = await App.create({ adapter: createMockAdapter() });
  const material = wireframeMaterial({ device, color: [0.25, 0.5, 0.75] });
  const buffer = device.createBuffer({ size: material.uniformByteSize, usage: ["uniform", "copy_dst"] });

  material.writeUniforms(buffer.gpu, 0, { viewProjectionMatrix: IDENTITY, modelMatrix: IDENTITY });

  const bytes = await buffer.read(material.uniformByteSize);
  expect(Array.from(new Float32Array(bytes).slice(32, 35))).toEqual([0.25, 0.5, 0.75]);
  device.destroy();
});

test("wireframeMaterial respects custom targetFormat", async () => {
  const { device } = await App.create({ adapter: createMockAdapter() });
  const createRenderPipeline = vi.spyOn(device.gpu, "createRenderPipeline");

  wireframeMaterial({ device, targetFormat: "rgba8unorm-srgb" });

  expect(createRenderPipeline).toHaveBeenCalledWith(expect.objectContaining({
    fragment: expect.objectContaining({ targets: [expect.objectContaining({ format: "rgba8unorm-srgb" })] }),
  }));
  device.destroy();
});

test("meshToWireframe converts Mesh.box to a line-list with deduplicated edges", async () => {
  const { device } = await App.create({ adapter: createMockAdapter() });
  const createBuffer = vi.spyOn(device.gpu, "createBuffer");
  const result = await meshToWireframe(Mesh.box({ device }), device);

  expect(result.lineCount).toBe(12);
  expect(result.indexFormat).toBe("uint16");
  expect(result.indexBuffer).toBeTruthy();
  const indexDescriptor = createBuffer.mock.calls.find(([desc]) => desc.label === "meshToWireframe.index")?.[0];
  expect(indexDescriptor?.usage).toBe((indexDescriptor?.usage ?? 0) | 16);
  device.destroy();
});

test("meshToWireframe preserves source vertex buffer reference", async () => {
  const { device } = await App.create({ adapter: createMockAdapter() });
  const sourceMesh = Mesh.box({ device });
  const result = await meshToWireframe(sourceMesh, device);

  expect(result.vertexBuffer).toBe(sourceMesh.vertexBuffer);
  device.destroy();
});
