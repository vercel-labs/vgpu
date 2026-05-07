import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { PNG } from "pngjs";
import { expect } from "vitest";
import type { Device } from "@vgpu/core";
import { degToRad, perspectiveCamera, type Mat4, type Mesh, type Vec3 } from "@vgpu/render";
import { normalDebugMaterial } from "@vgpu/render/inspect";
import type { EditableMesh, ElementSelection } from "@vgpu/render/edit";
import { unwrapKernel } from "../../src/edit/kernel-handle.ts";
import { renderInspectFrame } from "../inspect/_helpers.ts";
import { wireframeOverlayMaterial } from "./fixtures/wireframe-overlay-material.ts";

export const SNAPSHOT_DIR = "packages/render/tests/edit/__snapshots__";
export const ANGLES = { front: [0, 0.5, 3], iso: [2, 2, 3], side: [3, 0.75, 0.25] } as const;
const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) as Mat4;

export async function renderEditMesh(device: Device, mesh: Mesh, angle: keyof typeof ANGLES): Promise<Uint8Array> {
  const material = normalDebugMaterial({ device, targetFormat: "rgba8unorm-srgb" });
  return renderInspectFrame({ device, material, vertexBuffer: mesh.vertexBuffer.gpu, vertexCount: mesh.vertexCount, camera: camera(angle), targetFormat: "rgba8unorm-srgb" });
}

export async function renderEditMeshWireframe(device: Device, mesh: Mesh, angle: keyof typeof ANGLES, wireColor: readonly [number, number, number] = [1, 1, 1]): Promise<Uint8Array> {
  const color = device.createTexture({ size: [256, 256], format: "rgba8unorm-srgb", usage: ["render_attachment", "copy_src"] });
  const depth = device.createTexture({ size: [256, 256], format: "depth24plus", usage: ["render_attachment"] });
  const base = normalDebugMaterial({ device, targetFormat: "rgba8unorm-srgb" });
  const overlay = wireframeOverlayMaterial({ device, targetFormat: "rgba8unorm-srgb", color: wireColor });
  const baseUniform = device.createBuffer({ label: "edit-wireframe.base-uniform", size: base.uniformByteSize, usage: ["uniform", "copy_dst"] });
  const overlayUniform = device.createBuffer({ label: "edit-wireframe.overlay-uniform", size: overlay.uniformByteSize, usage: ["uniform", "copy_dst"] });
  try {
    const cam = camera(angle), modelMatrix = IDENTITY;
    const baseBindGroup = device.gpu.createBindGroup({ layout: base.bindGroupLayout, entries: [{ binding: 0, resource: { buffer: baseUniform.gpu } }] });
    const overlayBindGroup = device.gpu.createBindGroup({ layout: overlay.bindGroupLayout, entries: [{ binding: 0, resource: { buffer: overlayUniform.gpu } }] });
    base.writeUniforms(baseUniform.gpu, 0, { viewProjectionMatrix: cam.viewProjectionMatrix, modelMatrix });
    overlay.writeUniforms(overlayUniform.gpu, 0, { viewProjectionMatrix: cam.viewProjectionMatrix, modelMatrix });

    const encoder = device.gpu.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: color.createView(), loadOp: "clear", storeOp: "store", clearValue: { r: 0.05, g: 0.05, b: 0.08, a: 1 } }],
      depthStencilAttachment: { view: depth.createView(), depthClearValue: 1, depthLoadOp: "clear", depthStoreOp: "store" },
    });
    pass.setVertexBuffer(0, mesh.vertexBuffer.gpu);
    pass.setPipeline(base.pipeline); pass.setBindGroup(0, baseBindGroup); pass.draw(mesh.vertexCount, 1, 0, 0);
    pass.setPipeline(overlay.pipeline); pass.setBindGroup(0, overlayBindGroup); pass.draw(mesh.vertexCount, 1, 0, 0);
    pass.end();
    device.queue.gpu.submit([encoder.finish()]);
    const png = new PNG({ width: 256, height: 256 });
    png.data.set(await color.read());
    return PNG.sync.write(png);
  } finally {
    baseUniform.destroy(); overlayUniform.destroy(); depth.destroy(); color.destroy();
  }
}

export function highlightMesh(device: Device, em: EditableMesh, sel: ElementSelection): Mesh {
  const selected = new Set(sel.indices), k = unwrapKernel(em.gpu.halfEdgeKernel), data: number[] = [];
  for (let f = 0; f < k.faceCount; f++) for (let c = 0; c < 3; c++) {
    const edgeHit = sel.domain === "edge" && k.faceEdges.slice(f * 3, f * 3 + 3).some((e) => selected.has(e));
    const faceHit = sel.domain === "face" && selected.has(f);
    const vertHit = sel.domain === "vertex" && k.faceVertices.slice(f * 3, f * 3 + 3).some((v) => selected.has(v));
    const v = k.faceVertices[f * 3 + c] * 3, n = edgeHit || faceHit || vertHit ? [1, 0, 0] : [k.faceNormals[f * 3], k.faceNormals[f * 3 + 1], k.faceNormals[f * 3 + 2]];
    data.push(k.positions[v], k.positions[v + 1], k.positions[v + 2], n[0], n[1], n[2]);
  }
  const vertices = new Float32Array(data), vertexBuffer = device.createBuffer({ label: "edit-highlight", size: vertices.byteLength, usage: ["vertex", "copy_dst"] });
  vertexBuffer.write(vertices);
  return { vertexBuffer, vertexCount: vertices.length / 6, attributes: { stride: 24, position: { offset: 0, format: "float32x3" }, normal: { offset: 12, format: "float32x3" } }, bbox: em.bounds } as Mesh;
}

export async function expectEditSnapshot(name: string, pngBytes: Uint8Array): Promise<void> {
  const expectedPath = join(process.cwd(), SNAPSHOT_DIR, name);
  if (process.env.VGPU_WRITE_SNAPSHOTS === "1") { await mkdir(join(process.cwd(), SNAPSHOT_DIR), { recursive: true }); await writeFile(expectedPath, pngBytes); return; }
  const expected = PNG.sync.read(await readFile(expectedPath)), actual = PNG.sync.read(Buffer.from(pngBytes));
  expect(actual.width).toBe(256); expect(actual.height).toBe(256); expect(expected.width).toBe(256); expect(expected.height).toBe(256);
  expect(Buffer.compare(Buffer.from(actual.data), Buffer.from(expected.data))).toBe(0);
}

export function editableSignature(em: EditableMesh): string {
  const k = unwrapKernel(em.gpu.halfEdgeKernel), hash = createHash("sha256");
  hash.update(bytes(k.positions)); hash.update(bytes(k.faceVertices)); hash.update(bytes(k.isSharp)); hash.update(bytes(k.useSmooth));
  if (k.faceNormals) hash.update(bytes(k.faceNormals));
  return hash.digest("hex");
}

export function sha(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
function bytes(view: ArrayBufferView): Uint8Array { return new Uint8Array(view.buffer, view.byteOffset, view.byteLength); }
function camera(angle: keyof typeof ANGLES) { return perspectiveCamera({ fovYRadians: degToRad(45), aspect: 1, near: 0.1, far: 100, position: vec3(ANGLES[angle]), target: vec3([0, 0, 0]) }); }
function vec3(values: readonly number[]): Vec3 { return new Float32Array(values) as Vec3; }
