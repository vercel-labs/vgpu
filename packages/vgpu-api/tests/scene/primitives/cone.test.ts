import { init as initMock } from "../../../src/mock.ts";
import { init as initNode } from "../../../src/node.ts";
import { Mesh, cone, type MeshPrimitive } from "../../../src/scene/geometry-src/index.ts";
import { expect, test } from "vitest";
import { assertAllDistinct, expectSnapshot, primitiveCamera, renderPrimitiveFrame, type PrimitiveCameraAngle, type PrimitiveMaterialVariant } from "./_helpers.ts";

const ANGLES: readonly PrimitiveCameraAngle[] = ["front", "iso", "side"];
const MATERIALS: readonly PrimitiveMaterialVariant[] = ["pbr", "normalDebug32"];

test("Mesh.cone creates default smooth side data with a split flat cap", async () => {
  const { device } = await initMock();
  const mesh = Mesh.cone({ device, radius: 0.5, height: 1 });
  expectBasics(mesh, 100, 288, [-0.5, -0.5, -0.5], [0.5, 0.5, 0.5]);
  const vertices = new Float32Array(await mesh.vertexBuffer.read(mesh.vertexCount * 32));
  expectVec(vertices, 3, [1 / Math.hypot(1, 0.5), 0.5 / Math.hypot(1, 0.5), 0]);
  expectVec(vertices, 33 * 8, [0, 0.5, 0]);
  expect(Math.abs(dot(normal(vertices, 33), normal(vertices, 49)))).toBeLessThan(0.999);
  expect(Array.from(vertices.slice(67 * 8 + 3, 67 * 8 + 6))).toEqual([0, -1, 0]);
  expect(dot(normal(vertices, 0), normal(vertices, 67))).toBeLessThan(0.5);
  expect(Mesh.cone({ device, radius: 0.5, height: 1 })).toBe(mesh);
  device.destroy();
});

test("Mesh.cone with radialSegments=4 produces 4 distinct apex normals", async () => {
  const { device } = await initMock();
  const mesh = cone({ device, radius: 0.5, height: 1, radialSegments: 4 });
  const vertices = new Float32Array(await mesh.vertexBuffer.read(mesh.vertexCount * 32));
  const apex = [normal(vertices, 5), normal(vertices, 6), normal(vertices, 7), normal(vertices, 8)];
  for (let a = 0; a < apex.length; a++) for (let b = a + 1; b < apex.length; b++) expect(Math.abs(dot3(apex[a]!, apex[b]!))).toBeLessThan(0.999);
  device.destroy();
});

test("Mesh.cone validates params", async () => {
  const { device } = await initMock();
  expectInvalid(() => Mesh.cone({ device, radius: 0, height: 1 }));
  expectInvalid(() => Mesh.cone({ device, radius: 1, height: 0 }));
  expectInvalid(() => Mesh.cone({ device, radius: 1, height: 1, radialSegments: 2 }));
  expectInvalid(() => Mesh.cone({ device, radius: 1, height: 1, radialSegments: 400, heightSegments: 400 }), /uint16/);
  device.destroy();
});

test.skipIf(process.env.VGPU_DOCKER_TEST !== "1")("cone primitive snapshot battery matches", async () => {
  const { device } = await initNode();
  try { await snapshots("cone", (material, angle) => renderPrimitiveFrame({ device, mesh: Mesh.cone({ device, radius: 0.5, height: 1, radialSegments: 32 }), camera: primitiveCamera(angle), material, baseColor: [0.8, 0.45, 0.35] })); }
  finally { device.destroy(); }
});

function expectBasics(mesh: MeshPrimitive, vertices: number, indices: number, min: number[], max: number[]): void { expect(mesh.vertexCount).toBe(vertices); expect(mesh.indexCount).toBe(indices); expect(mesh.indexFormat).toBe("uint16"); expect(mesh.attributes.stride).toBe(32); expect(mesh.layout).toBe("position-normal-uv"); for (let i = 0; i < 3; i++) { expect(mesh.bbox.min[i]).toBeCloseTo(min[i]!, 6); expect(mesh.bbox.max[i]).toBeCloseTo(max[i]!, 6); } }
function normal(vertices: Float32Array, index: number): readonly [number, number, number] { const o = index * 8 + 3; return [vertices[o]!, vertices[o + 1]!, vertices[o + 2]!]; }
function dot3(a: readonly [number, number, number], b: readonly [number, number, number]): number { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function dot(a: readonly [number, number, number], b: readonly [number, number, number]): number { return dot3(a, b); }
function expectVec(vertices: Float32Array, offset: number, expected: number[]): void { for (let i = 0; i < 3; i++) expect(vertices[offset + i]).toBeCloseTo(expected[i]!, 5); }
function expectInvalid(fn: () => unknown, message?: RegExp): void { try { fn(); throw new Error("Expected VGPU-CORE-INVALID-USAGE"); } catch (error) { expect(error).toMatchObject({ code: "VGPU-CORE-INVALID-USAGE" }); if (message) expect(error).toMatchObject({ message: expect.stringMatching(message) }); } }
async function snapshots(prefix: string, render: (material: PrimitiveMaterialVariant, angle: PrimitiveCameraAngle) => Promise<Uint8Array>): Promise<void> { const pngs: Record<string, Uint8Array> = {}; for (const material of MATERIALS) for (const angle of ANGLES) { const name = `${prefix}-${material}-${angle}.png`; pngs[name] = await render(material, angle); } assertAllDistinct(pngs); for (const [name, bytes] of Object.entries(pngs)) await expectSnapshot(name, bytes); }
