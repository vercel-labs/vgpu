import { init as initMock } from "../../../src/mock.ts";
import { init as initNode } from "../../../src/node.ts";
import { Mesh, type MeshPrimitive } from "../../../src/scene/geometry-src/index.ts";
import { expect, test } from "vitest";
import { assertAllDistinct, expectSnapshot, primitiveCamera, renderPrimitiveFrame, type PrimitiveCameraAngle, type PrimitiveMaterialVariant } from "./helpers.ts";

const ANGLES: readonly PrimitiveCameraAngle[] = ["front", "iso", "side"];
const MATERIALS: readonly PrimitiveMaterialVariant[] = ["pbr", "normalDebug32"];

test("Mesh.disk creates indexed +Y position-normal-uv data", async () => {
  const { device } = await initMock();
  const mesh = Mesh.disk({ device, radius: 0.6 });
  expectBasics(mesh, 33, 96, [-0.6, 0, -0.6], [0.6, 0, 0.6]);
  const vertices = new Float32Array(await mesh.vertexBuffer.read(mesh.vertexCount * 32));
  expect(Array.from(vertices.slice(0, 3))).toEqual([0, 0, 0]);
  expect(Array.from(vertices.slice(6, 8))).toEqual([0.5, 0.5]);
  for (let i = 0; i < mesh.vertexCount; i++) expect(Array.from(vertices.slice(i * 8 + 3, i * 8 + 6))).toEqual([0, 1, 0]);
  for (let i = 1; i < mesh.vertexCount; i++) expect(Math.hypot(vertices[i * 8]!, vertices[i * 8 + 2]!)).toBeCloseTo(0.6, 6);
  expect(Array.from(vertices.slice(14, 16))).toEqual([1, 0.5]);
  device.destroy();
});

test("Mesh.disk caches per params", async () => {
  const { device } = await initMock();
  const a = Mesh.disk({ device, radius: 1, segments: 24 });
  const b = Mesh.disk({ device, radius: 1, segments: 24 });
  expect(a).toBe(b);
  device.destroy();
});

test("Mesh.disk validates params", async () => {
  const { device } = await initMock();
  expectInvalid(() => Mesh.disk({ device, radius: 0 }));
  expectInvalid(() => Mesh.disk({ device, radius: 1, segments: 2 }));
  expectInvalid(() => Mesh.disk({ device, radius: 1, segments: 65534 }), /uint16/);
  device.destroy();
});

test.skipIf(process.env.VGPU_DOCKER_TEST !== "1")("disk primitive snapshot battery matches", async () => {
  const { device } = await initNode();
  try { await snapshots("disk", (material, angle) => renderPrimitiveFrame({ device, mesh: Mesh.disk({ device, radius: 0.6, segments: 24 }), camera: primitiveCamera(angle), material, baseColor: [0.85, 0.55, 0.35] })); }
  finally { device.destroy(); }
});

function expectBasics(mesh: MeshPrimitive, vertices: number, indices: number, min: number[], max: number[]): void {
  expect(mesh.vertexCount).toBe(vertices); expect(mesh.indexCount).toBe(indices); expect(mesh.indexFormat).toBe("uint16"); expect(mesh.attributes.stride).toBe(32); expect(mesh.layout).toBe("position-normal-uv");
  for (let i = 0; i < 3; i++) { expect(mesh.bbox.min[i]).toBeCloseTo(min[i]!, 6); expect(mesh.bbox.max[i]).toBeCloseTo(max[i]!, 6); }
  expect(mesh.gpu).toEqual({ vertexBuffer: mesh.vertexBuffer.gpu, indexBuffer: mesh.indexBuffer?.gpu });
}

function expectInvalid(fn: () => unknown, message?: RegExp): void {
  try { fn(); throw new Error("Expected VGPU-CORE-INVALID-USAGE"); } catch (error) { expect(error).toMatchObject({ code: "VGPU-CORE-INVALID-USAGE" }); if (message) expect(error).toMatchObject({ message: expect.stringMatching(message) }); }
}

async function snapshots(prefix: string, render: (material: PrimitiveMaterialVariant, angle: PrimitiveCameraAngle) => Promise<Uint8Array>): Promise<void> {
  const pngs: Record<string, Uint8Array> = {};
  for (const material of MATERIALS) for (const angle of ANGLES) { const name = `${prefix}-${material}-${angle}.png`; pngs[name] = await render(material, angle); }
  assertAllDistinct(pngs);
  for (const [name, bytes] of Object.entries(pngs)) await expectSnapshot(name, bytes);
}
