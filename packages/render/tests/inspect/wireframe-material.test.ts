import { createMockAdapter } from "@vgpu/adapter-mock";
import { App, type Device } from "@vgpu/core";
import { Mesh, type Mesh as MeshLike, type Vec3 } from "@vgpu/render";
import { meshToWireframe, wireframeMaterial } from "@vgpu/render/inspect";
import { expect, test, vi } from "vitest";
import { createReadableBoxMesh } from "./_helpers.ts";

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

test("meshToWireframe converts a readable cube to deduplicated edges", async () => {
  const { device } = await App.create({ adapter: createMockAdapter() });
  const createBuffer = vi.spyOn(device.gpu, "createBuffer");
  const result = await meshToWireframe(createReadableBoxMesh(device), device);

  expect(result.lineCount).toBe(12);
  expect(result.indexFormat).toBe("uint16");
  expect(result.indexBuffer).toBeTruthy();
  const indexDescriptor = createBuffer.mock.calls.find(([desc]) => desc.label === "meshToWireframe.index")?.[0];
  expect(indexDescriptor?.usage).toBe((indexDescriptor?.usage ?? 0) | 16);
  device.destroy();
});

test("meshToWireframe rejects unreadable Mesh.box", async () => {
  const { device } = await App.create({ adapter: createMockAdapter() });

  await expect(meshToWireframe(Mesh.box({ device }), device)).rejects.toMatchObject({
    code: "VGPU-CORE-INVALID-USAGE",
    where: "meshToWireframe",
  });
  device.destroy();
});

test("meshToWireframe keeps smooth-shaded non-coplanar shared edges", async () => {
  const { device } = await App.create({ adapter: createMockAdapter() });
  const result = await meshToWireframe(nonCoplanarSharedEdgeMesh(device), device);

  expect(result.lineCount).toBe(5);
  device.destroy();
});

test("meshToWireframe preserves source vertex buffer reference", async () => {
  const { device } = await App.create({ adapter: createMockAdapter() });
  const sourceMesh = createReadableBoxMesh(device);
  const result = await meshToWireframe(sourceMesh, device);

  expect(result.vertexBuffer).toBe(sourceMesh.vertexBuffer);
  device.destroy();
});

function nonCoplanarSharedEdgeMesh(device: Device): MeshLike {
  const vertices = new Float32Array([
    0, 0, 0, 0, 0, 1,
    1, 0, 0, 0, 0, 1,
    0, 1, 0, 0, 0, 1,
    0, 0, 0, 0, 0, 1,
    1, 0, 0, 0, 0, 1,
    0, 0, 1, 0, 0, 1,
  ]);
  const vertexBuffer = device.createBuffer({ size: vertices.byteLength, usage: ["vertex", "copy_dst", "copy_src"] });
  vertexBuffer.write(vertices);
  return Object.freeze({
    vertexBuffer,
    vertexCount: 6,
    attributes: {
      stride: 24,
      position: { offset: 0, format: "float32x3" },
      normal: { offset: 12, format: "float32x3" },
    },
    bbox: { min: new Float32Array([0, 0, 0]) as Vec3, max: new Float32Array([1, 1, 1]) as Vec3 },
  });
}
