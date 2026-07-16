import { createMockAdapter } from "@vgpu/adapter-mock";

import type { Device } from "@vgpu/core";
import { Mesh, type Mesh as MeshLike, type Vec3 } from "../fixtures/mesh.ts";
import { meshToReadable, meshToWireframe } from "@vgpu/render/inspect";
import { expect, test } from "vitest";

test("returns same mesh when input already has COPY_SRC", async () => {
  const device = await createMockAdapter().requestDevice();
  const mesh = createMesh(device, ["vertex", "copy_dst", "copy_src"]);
  expect(await meshToReadable(mesh, device)).toBe(mesh);
  device.destroy();
});

test("promotes mesh without COPY_SRC to one with COPY_SRC", async () => {
  const device = await createMockAdapter().requestDevice();
  const mesh = createMesh(device, ["vertex", "copy_dst"]);
  const readable = await meshToReadable(mesh, device);
  expect((readable.vertexBuffer.gpu.usage & copySrcUsage()) !== 0).toBe(true);
  device.destroy();
});

test("preserves original usage flags", async () => {
  const device = await createMockAdapter().requestDevice();
  const mesh = createMesh(device, ["vertex", "copy_dst"]);
  const readable = await meshToReadable(mesh, device);
  expect(readable.vertexBuffer.options.usage).toEqual(["vertex", "copy_dst", "copy_src"]);
  device.destroy();
});

test("preserves index buffer reference", async () => {
  const device = await createMockAdapter().requestDevice();
  const mesh = createMesh(device, ["vertex", "copy_dst"], true);
  const readable = await meshToReadable(mesh, device) as MeshLike & { readonly indexBuffer?: GPUBuffer };
  expect(readable.indexBuffer).toBe(mesh.indexBuffer);
  device.destroy();
});

test("preserves vertex count", async () => {
  const device = await createMockAdapter().requestDevice();
  const mesh = createMesh(device, ["vertex", "copy_dst"]);
  const readable = await meshToReadable(mesh, device);
  expect(readable.vertexCount).toBe(mesh.vertexCount);
  device.destroy();
});

test("vertex bytes are byte-identical after promotion", async () => {
  const device = await createMockAdapter().requestDevice();
  const vertices = new Float32Array([1, 2, 3, 0, 0, 1, 4, 5, 6, 0, 1, 0, 7, 8, 9, 1, 0, 0]);
  const mesh = createMesh(device, ["vertex", "copy_dst"], false, vertices);
  const readable = await meshToReadable(mesh, device);
  expect(Array.from(new Uint8Array(await readable.vertexBuffer.read(vertices.byteLength)))).toEqual(Array.from(new Uint8Array(vertices.buffer.slice(0))));
  device.destroy();
});

test("Mesh.box can be promoted then converted to wireframe", async () => {
  const device = await createMockAdapter().requestDevice();
  const wireframe = await meshToWireframe(await meshToReadable(Mesh.box({ device }), device), device);
  expect(wireframe.lineCount).toBe(12);
  expect(wireframe.indexFormat).toBe("uint16");
  device.destroy();
});

function createMesh(
  device: Device,
  usage: readonly ["vertex", ...("copy_dst" | "copy_src")[]],
  withIndex = false,
  vertices = new Float32Array([0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 1]),
): MeshLike & { readonly indexBuffer?: GPUBuffer } {
  const vertexBuffer = device.createBuffer({ size: vertices.byteLength, usage });
  vertexBuffer.write(vertices);
  const indexBuffer = withIndex ? device.createBuffer({ size: 6, usage: ["index", "copy_dst"] }).gpu : undefined;
  return Object.freeze({
    vertexBuffer,
    vertexCount: 3,
    indexBuffer,
    attributes: {
      stride: 24,
      position: { offset: 0, format: "float32x3" as const },
      normal: { offset: 12, format: "float32x3" as const },
    },
    bbox: { min: new Float32Array([0, 0, 0]) as Vec3, max: new Float32Array([1, 1, 0]) as Vec3 },
  });
}

function copySrcUsage(): GPUBufferUsageFlags {
  return (globalThis.GPUBufferUsage?.COPY_SRC ?? 4) as GPUBufferUsageFlags;
}
