import { createMockAdapter } from "@vgpu/adapter-mock";
import { createNodeAdapter } from "@vgpu/adapter-node";
import { App } from "@vgpu/core";
import { Mesh, type MeshPrimitive } from "@vgpu/render";
import { expect, test } from "vitest";
import { assertAllDistinct, expectSnapshot, primitiveCamera, renderPrimitiveFrame, type PrimitiveCameraAngle, type PrimitiveMaterialVariant } from "./_helpers.ts";

const ANGLES: readonly PrimitiveCameraAngle[] = ["front", "iso", "side"];
const MATERIALS: readonly PrimitiveMaterialVariant[] = ["pbr", "normalDebug32"];

test("Mesh.torus creates default smooth position-normal-uv data", async () => {
  const { device } = await App.create({ adapter: createMockAdapter() });
  const mesh = Mesh.torus({ device, radius: 1, tube: 0.4 });
  expectBasics(mesh, 561, 3072, [-1.4, -0.4, -1.4], [1.4, 0.4, 1.4]);
  const vertices = new Float32Array(await mesh.vertexBuffer.read(mesh.vertexCount * 32));
  expectVec(position(vertices, 0), [1.4, 0, 0]);
  expectVec(normal(vertices, 0), [1, 0, 0]);
  expectVec(position(vertices, 8), [0.6, 0, 0]);
  expectVec(normal(vertices, 8), [-1, 0, 0]);
  expect(Mesh.torus({ device, radius: 1, tube: 0.4 })).toBe(mesh);
  device.destroy();
});

test("Mesh.torus validates params and overflow", async () => {
  const { device } = await App.create({ adapter: createMockAdapter() });
  expectInvalid(() => Mesh.torus({ device, radius: 1, tube: 1 }));
  expectInvalid(() => Mesh.torus({ device, radius: 1, tube: 0 }));
  expectInvalid(() => Mesh.torus({ device, radius: 1, tube: 0.25, radialSegments: 2 }));
  expectInvalid(() => Mesh.torus({ device, radius: 1, tube: 0.25, tubularSegments: 2 }));
  expectInvalid(() => Mesh.torus({ device, radius: 1, tube: 0.25, arc: 0 }));
  expectInvalid(() => Mesh.torus({ device, radius: 1, tube: 0.25, radialSegments: 255, tubularSegments: 255 }), /uint16/);
  device.destroy();
});

test.skipIf(process.env.VGPU_DOCKER_TEST !== "1")("torus primitive snapshot battery matches", async () => {
  const { device } = await App.create({ adapter: createNodeAdapter() });
  try { await snapshots("torus", (material, angle) => renderPrimitiveFrame({ device, mesh: Mesh.torus({ device, radius: 0.5, tube: 0.18, radialSegments: 12, tubularSegments: 24 }), camera: primitiveCamera(angle), material, baseColor: [0.7, 0.45, 0.85] })); }
  finally { device.destroy(); }
});

function expectBasics(mesh: MeshPrimitive, vertices: number, indices: number, min: number[], max: number[]): void { expect(mesh.vertexCount).toBe(vertices); expect(mesh.indexCount).toBe(indices); expect(mesh.indexFormat).toBe("uint16"); expect(mesh.attributes.stride).toBe(32); expect(mesh.layout).toBe("position-normal-uv"); for (let i = 0; i < 3; i++) { expect(mesh.bbox.min[i]).toBeCloseTo(min[i]!, 6); expect(mesh.bbox.max[i]).toBeCloseTo(max[i]!, 6); } }
function position(vertices: Float32Array, index: number): readonly [number, number, number] { const o = index * 8; return [vertices[o]!, vertices[o + 1]!, vertices[o + 2]!]; }
function normal(vertices: Float32Array, index: number): readonly [number, number, number] { const o = index * 8 + 3; return [vertices[o]!, vertices[o + 1]!, vertices[o + 2]!]; }
function expectVec(actual: readonly [number, number, number], expected: number[]): void { for (let i = 0; i < 3; i++) expect(actual[i]).toBeCloseTo(expected[i]!, 6); }
function expectInvalid(fn: () => unknown, message?: RegExp): void { try { fn(); throw new Error("Expected VGPU-CORE-INVALID-USAGE"); } catch (error) { expect(error).toMatchObject({ code: "VGPU-CORE-INVALID-USAGE" }); if (message) expect(error).toMatchObject({ message: expect.stringMatching(message) }); } }
async function snapshots(prefix: string, render: (material: PrimitiveMaterialVariant, angle: PrimitiveCameraAngle) => Promise<Uint8Array>): Promise<void> { const pngs: Record<string, Uint8Array> = {}; for (const material of MATERIALS) for (const angle of ANGLES) { const name = `${prefix}-${material}-${angle}.png`; pngs[name] = await render(material, angle); } assertAllDistinct(pngs); for (const [name, bytes] of Object.entries(pngs)) await expectSnapshot(name, bytes); }
