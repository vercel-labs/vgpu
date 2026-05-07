import { createMockAdapter } from "@vgpu/adapter-mock";
import { createNodeAdapter } from "@vgpu/adapter-node";
import { App } from "@vgpu/core";
import { Mesh, type MeshPrimitive } from "@vgpu/render";
import { expect, test } from "vitest";
import { assertAllDistinct, expectSnapshot, primitiveCamera, renderPrimitiveFrame, type PrimitiveCameraAngle, type PrimitiveMaterialVariant } from "./_helpers.ts";

const ANGLES: readonly PrimitiveCameraAngle[] = ["front", "iso", "side"];
const MATERIALS: readonly PrimitiveMaterialVariant[] = ["pbr", "normalDebug32"];

test("Mesh.plane creates indexed +Y position-normal-uv data", async () => {
  const { device } = await App.create({ adapter: createMockAdapter() });
  const mesh = Mesh.plane({ device });
  expectBasics(mesh, 4, 6, [-0.5, 0, -0.5], [0.5, 0, 0.5]);
  const vertices = new Float32Array(await mesh.vertexBuffer.read(mesh.vertexCount * 32));
  for (let i = 0; i < mesh.vertexCount; i++) expect(Array.from(vertices.slice(i * 8 + 3, i * 8 + 6))).toEqual([0, 1, 0]);
  const uvs = uvRange(vertices);
  expect(uvs).toEqual({ minU: 0, maxU: 1, minV: 0, maxV: 1 });
  device.destroy();
});

test("Mesh.plane respects segments and caches per params", async () => {
  const { device } = await App.create({ adapter: createMockAdapter() });
  const a = Mesh.plane({ device, widthSegments: 2, heightSegments: 3 });
  const b = Mesh.plane({ device, widthSegments: 2, heightSegments: 3 });
  expect(a.vertexCount).toBe(12);
  expect(a.indexCount).toBe(36);
  expect(a).toBe(b);
  device.destroy();
});

test("Mesh.plane validates params", async () => {
  const { device } = await App.create({ adapter: createMockAdapter() });
  expectInvalid(() => Mesh.plane({ device, width: -1 }));
  expectInvalid(() => Mesh.plane({ device, heightSegments: 0 }));
  expectInvalid(() => Mesh.plane({ device, widthSegments: 256, heightSegments: 256 }), /uint16/);
  device.destroy();
});

test.skipIf(process.env.VGPU_DOCKER_TEST !== "1")("plane primitive snapshot battery matches", async () => {
  const { device } = await App.create({ adapter: createNodeAdapter() });
  try { await snapshots("plane", (material, angle) => renderPrimitiveFrame({ device, mesh: Mesh.plane({ device, width: 1.5, height: 1, widthSegments: 4, heightSegments: 3 }), camera: primitiveCamera(angle), material, baseColor: [0.4, 0.65, 0.85] })); }
  finally { device.destroy(); }
});

function expectBasics(mesh: MeshPrimitive, vertices: number, indices: number, min: number[], max: number[]): void {
  expect(mesh.vertexCount).toBe(vertices); expect(mesh.indexCount).toBe(indices); expect(mesh.indexFormat).toBe("uint16"); expect(mesh.attributes.stride).toBe(32); expect(mesh.layout).toBe("position-normal-uv");
  expect(Array.from(mesh.bbox.min)).toEqual(min); expect(Array.from(mesh.bbox.max)).toEqual(max); expect(mesh.gpu).toEqual({ vertexBuffer: mesh.vertexBuffer.gpu, indexBuffer: mesh.indexBuffer?.gpu });
}

function uvRange(vertices: Float32Array): { minU: number; maxU: number; minV: number; maxV: number } {
  let minU = 1, maxU = 0, minV = 1, maxV = 0;
  for (let i = 0; i < vertices.length; i += 8) { minU = Math.min(minU, vertices[i + 6]!); maxU = Math.max(maxU, vertices[i + 6]!); minV = Math.min(minV, vertices[i + 7]!); maxV = Math.max(maxV, vertices[i + 7]!); }
  return { minU, maxU, minV, maxV };
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
