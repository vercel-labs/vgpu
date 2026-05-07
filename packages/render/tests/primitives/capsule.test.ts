import { createMockAdapter } from "@vgpu/adapter-mock";
import { createNodeAdapter } from "@vgpu/adapter-node";
import { App } from "@vgpu/core";
import { Mesh, type MeshPrimitive } from "@vgpu/render";
import { expect, test } from "vitest";
import { assertAllDistinct, expectSnapshot, primitiveCamera, renderPrimitiveFrame, type PrimitiveCameraAngle, type PrimitiveMaterialVariant } from "./_helpers.ts";

const ANGLES: readonly PrimitiveCameraAngle[] = ["front", "iso", "side"];
const MATERIALS: readonly PrimitiveMaterialVariant[] = ["pbr", "normalDebug32"];

test("Mesh.capsule creates default smooth position-normal-uv data", async () => {
  const { device } = await App.create({ adapter: createMockAdapter() });
  const mesh = Mesh.capsule({ device, radius: 0.25, height: 0.5 });
  expectBasics(mesh, 825, 4608, [-0.25, -0.5, -0.25], [0.25, 0.5, 0.25]);
  const vertices = new Float32Array(await mesh.vertexBuffer.read(mesh.vertexCount * 32));
  expectVec(normal(vertices, 12 * 33), [1, 0, 0]);
  expectVec(normal(vertices, 24 * 33), [0, 1, 0]);
  expect(Mesh.capsule({ device, radius: 0.25, height: 0.5 })).toBe(mesh);
  device.destroy();
});

test("Mesh.capsule validates params and overflow", async () => {
  const { device } = await App.create({ adapter: createMockAdapter() });
  expect(Mesh.capsule({ device, radius: 0.5, height: 0 }).vertexCount).toBe(825);
  expectInvalid(() => Mesh.capsule({ device, radius: 0, height: 1 }));
  expectInvalid(() => Mesh.capsule({ device, radius: 1, height: -1 }));
  expectInvalid(() => Mesh.capsule({ device, radius: 1, height: 1, radialSegments: 2 }));
  expectInvalid(() => Mesh.capsule({ device, radius: 1, height: 1, heightSegments: 1 }));
  expectInvalid(() => Mesh.capsule({ device, radius: 1, height: 1, radialSegments: 400, heightSegments: 80 }), /uint16/);
  device.destroy();
});

test.skipIf(process.env.VGPU_DOCKER_TEST !== "1")("capsule primitive snapshot battery matches", async () => {
  const { device } = await App.create({ adapter: createNodeAdapter() });
  try { await snapshots("capsule", (material, angle) => renderPrimitiveFrame({ device, mesh: Mesh.capsule({ device, radius: 0.3, height: 0.6, radialSegments: 24, heightSegments: 6 }), camera: primitiveCamera(angle), material, baseColor: [0.55, 0.75, 0.4] })); }
  finally { device.destroy(); }
});

function expectBasics(mesh: MeshPrimitive, vertices: number, indices: number, min: number[], max: number[]): void { expect(mesh.vertexCount).toBe(vertices); expect(mesh.indexCount).toBe(indices); expect(mesh.indexFormat).toBe("uint16"); expect(mesh.attributes.stride).toBe(32); expect(mesh.layout).toBe("position-normal-uv"); for (let i = 0; i < 3; i++) { expect(mesh.bbox.min[i]).toBeCloseTo(min[i]!, 6); expect(mesh.bbox.max[i]).toBeCloseTo(max[i]!, 6); } }
function normal(vertices: Float32Array, index: number): readonly [number, number, number] { const o = index * 8 + 3; return [vertices[o]!, vertices[o + 1]!, vertices[o + 2]!]; }
function expectVec(actual: readonly [number, number, number], expected: number[]): void { for (let i = 0; i < 3; i++) expect(actual[i]).toBeCloseTo(expected[i]!, 5); }
function expectInvalid(fn: () => unknown, message?: RegExp): void { try { fn(); throw new Error("Expected VGPU-CORE-INVALID-USAGE"); } catch (error) { expect(error).toMatchObject({ code: "VGPU-CORE-INVALID-USAGE" }); if (message) expect(error).toMatchObject({ message: expect.stringMatching(message) }); } }
async function snapshots(prefix: string, render: (material: PrimitiveMaterialVariant, angle: PrimitiveCameraAngle) => Promise<Uint8Array>): Promise<void> { const pngs: Record<string, Uint8Array> = {}; for (const material of MATERIALS) for (const angle of ANGLES) { const name = `${prefix}-${material}-${angle}.png`; pngs[name] = await render(material, angle); } assertAllDistinct(pngs); for (const [name, bytes] of Object.entries(pngs)) await expectSnapshot(name, bytes); }
