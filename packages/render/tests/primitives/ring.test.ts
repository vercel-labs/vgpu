import { createMockAdapter } from "@vgpu/adapter-mock";
import { createNodeAdapter } from "@vgpu/adapter-node";
import { App } from "@vgpu/core";
import { Mesh, type MeshPrimitive } from "@vgpu/render";
import { expect, test } from "vitest";
import { assertAllDistinct, expectSnapshot, primitiveCamera, renderPrimitiveFrame, type PrimitiveCameraAngle, type PrimitiveMaterialVariant } from "./_helpers.ts";

const ANGLES: readonly PrimitiveCameraAngle[] = ["front", "iso", "side"];
const MATERIALS: readonly PrimitiveMaterialVariant[] = ["pbr", "normalDebug32"];

test("Mesh.ring creates indexed +Y position-normal-uv data", async () => {
  const { device } = await App.create({ adapter: createMockAdapter() });
  const mesh = Mesh.ring({ device, innerRadius: 0.3, outerRadius: 0.6 });
  expectBasics(mesh, 66, 192, [-0.6, 0, -0.6], [0.6, 0, 0.6]);
  const vertices = new Float32Array(await mesh.vertexBuffer.read(mesh.vertexCount * 32));
  for (let i = 0; i < mesh.vertexCount; i++) expect(Array.from(vertices.slice(i * 8 + 3, i * 8 + 6))).toEqual([0, 1, 0]);
  expect(Math.hypot(vertices[0]!, vertices[2]!)).toBeCloseTo(0.3, 6);
  expect(Math.hypot(vertices[8]!, vertices[10]!)).toBeCloseTo(0.6, 6);
  device.destroy();
});

test("Mesh.ring caches per params", async () => {
  const { device } = await App.create({ adapter: createMockAdapter() });
  const a = Mesh.ring({ device, innerRadius: 0.25, outerRadius: 1, segments: 24 });
  const b = Mesh.ring({ device, innerRadius: 0.25, outerRadius: 1, segments: 24 });
  expect(a).toBe(b);
  device.destroy();
});

test("Mesh.ring validates params", async () => {
  const { device } = await App.create({ adapter: createMockAdapter() });
  expectInvalid(() => Mesh.ring({ device, innerRadius: 0, outerRadius: 1 }));
  expectInvalid(() => Mesh.ring({ device, innerRadius: 1, outerRadius: 1 }));
  expectInvalid(() => Mesh.ring({ device, innerRadius: 0.5, outerRadius: 1, segments: 2 }));
  expectInvalid(() => Mesh.ring({ device, innerRadius: 0.5, outerRadius: 1, segments: 32767 }), /uint16/);
  device.destroy();
});

test.skipIf(process.env.VGPU_DOCKER_TEST !== "1")("ring primitive snapshot battery matches", async () => {
  const { device } = await App.create({ adapter: createNodeAdapter() });
  try { await snapshots("ring", (material, angle) => renderPrimitiveFrame({ device, mesh: Mesh.ring({ device, innerRadius: 0.25, outerRadius: 0.6, segments: 32 }), camera: primitiveCamera(angle), material, baseColor: [0.45, 0.8, 0.45] })); }
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
