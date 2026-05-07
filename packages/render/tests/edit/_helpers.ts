import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import { expect } from "vitest";
import type { Device } from "@vgpu/core";
import { degToRad, perspectiveCamera, type Mesh, type Vec3 } from "@vgpu/render";
import { normalDebugMaterial } from "@vgpu/render/inspect";
import type { EditableMesh, ElementSelection } from "@vgpu/render/edit";
import { renderInspectFrame } from "../inspect/_helpers.ts";

export const SNAPSHOT_DIR = "packages/render/tests/edit/__snapshots__";
export const ANGLES = {
  front: [0, 0.5, 3],
  iso: [2, 2, 3],
  side: [3, 0.75, 0.25],
} as const;

export async function renderEditMesh(device: Device, mesh: Mesh, angle: keyof typeof ANGLES): Promise<Uint8Array> {
  const material = normalDebugMaterial({ device, targetFormat: "rgba8unorm-srgb" });
  return renderInspectFrame({ device, material, vertexBuffer: mesh.vertexBuffer.gpu, vertexCount: mesh.vertexCount, camera: camera(angle), targetFormat: "rgba8unorm-srgb" });
}

export function highlightMesh(device: Device, em: EditableMesh, faces: ElementSelection): Mesh {
  const selected = new Set(faces.indices), k = em.gpu.halfEdgeKernel, data: number[] = [];
  for (let f = 0; f < k.faceCount; f++) for (let c = 0; c < 3; c++) {
    const v = k.faceVertices[f * 3 + c] * 3, n = selected.has(f) ? [1, 0, 0] : [k.faceNormals[f * 3], k.faceNormals[f * 3 + 1], k.faceNormals[f * 3 + 2]];
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
  expect(pixelmatch(actual.data, expected.data, null, 256, 256, { threshold: 0.001 })).toBe(0);
}

export function sha(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
function camera(angle: keyof typeof ANGLES) { return perspectiveCamera({ fovYRadians: degToRad(45), aspect: 1, near: 0.1, far: 100, position: vec3(ANGLES[angle]), target: vec3([0, 0, 0]) }); }
function vec3(values: readonly number[]): Vec3 { return new Float32Array(values) as Vec3; }
