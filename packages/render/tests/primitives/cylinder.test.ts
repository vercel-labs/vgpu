import { createMockAdapter } from "@vgpu/adapter-mock";
import { createNodeAdapter } from "@vgpu/adapter-node";
import { App } from "@vgpu/core";
import { Mesh, type MeshPrimitive } from "@vgpu/render";
import { expect, test } from "vitest";
import { assertAllDistinct, expectSnapshot, primitiveCamera, renderPrimitiveFrame, type PrimitiveCameraAngle, type PrimitiveMaterialVariant } from "./_helpers.ts";

const ANGLES: readonly PrimitiveCameraAngle[] = ["front", "iso", "side"];
const MATERIALS: readonly PrimitiveMaterialVariant[] = ["pbr", "normalDebug32"];

test("Mesh.cylinder creates default smooth side data with split flat caps", async () => {
  const { device } = await App.create({ adapter: createMockAdapter() });
  const mesh = Mesh.cylinder({ device, radius: 0.5, height: 1 });
  expectBasics(mesh, 134, 384, [-0.5, -0.5, -0.5], [0.5, 0.5, 0.5]);
  const vertices = new Float32Array(await mesh.vertexBuffer.read(mesh.vertexCount * 32));
  expectVec(normal(vertices, 0), [1, 0, 0]);
  expectVec(normal(vertices, 67), [0, 1, 0]);
  expect(dot(normal(vertices, 33), normal(vertices, 67))).toBeLessThan(0.5);
  expect(Mesh.cylinder({ device, radius: 0.5, height: 1 })).toBe(mesh);
  device.destroy();
});

test("Mesh.cylinder accepts radius overrides and validates ambiguity", async () => {
  const { device } = await App.create({ adapter: createMockAdapter() });
  const coneLike = Mesh.cylinder({ device, radius: 0.5, radiusTop: 0, height: 1 });
  expect(coneLike.vertexCount).toBe(100);
  expect(coneLike.indexCount).toBe(288);
  expectInvalid(() => Mesh.cylinder({ device, radius: 1, radiusTop: 0.5, radiusBottom: 0.25, height: 1 }), /pass radius OR/);
  expectInvalid(() => Mesh.cylinder({ device, radius: -1, height: 1 }));
  expectInvalid(() => Mesh.cylinder({ device, radius: 0, height: 1 }));
  expectInvalid(() => Mesh.cylinder({ device, radius: 1, height: 1, radialSegments: 2 }));
  expectInvalid(() => Mesh.cylinder({ device, radius: 1, height: 1, radialSegments: 400, heightSegments: 400 }), /uint16/);
  device.destroy();
});

test.skipIf(process.env.VGPU_DOCKER_TEST !== "1")("cylinder primitive snapshot battery matches", async () => {
  const { device } = await App.create({ adapter: createNodeAdapter() });
  try { await snapshots("cylinder", (material, angle) => renderPrimitiveFrame({ device, mesh: Mesh.cylinder({ device, radius: 0.4, height: 1, radialSegments: 32 }), camera: primitiveCamera(angle), material, baseColor: [0.35, 0.65, 0.8] })); }
  finally { device.destroy(); }
});

function expectBasics(mesh: MeshPrimitive, vertices: number, indices: number, min: number[], max: number[]): void { expect(mesh.vertexCount).toBe(vertices); expect(mesh.indexCount).toBe(indices); expect(mesh.indexFormat).toBe("uint16"); expect(mesh.attributes.stride).toBe(32); expect(mesh.layout).toBe("position-normal-uv"); for (let i = 0; i < 3; i++) { expect(mesh.bbox.min[i]).toBeCloseTo(min[i]!, 6); expect(mesh.bbox.max[i]).toBeCloseTo(max[i]!, 6); } }
function normal(vertices: Float32Array, index: number): readonly [number, number, number] { const o = index * 8 + 3; return [vertices[o]!, vertices[o + 1]!, vertices[o + 2]!]; }
function dot(a: readonly [number, number, number], b: readonly [number, number, number]): number { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function expectVec(actual: readonly [number, number, number], expected: number[]): void { for (let i = 0; i < 3; i++) expect(actual[i]).toBeCloseTo(expected[i]!, 5); }
function expectInvalid(fn: () => unknown, message?: RegExp): void { try { fn(); throw new Error("Expected VGPU-CORE-INVALID-USAGE"); } catch (error) { expect(error).toMatchObject({ code: "VGPU-CORE-INVALID-USAGE" }); if (message) expect(error).toMatchObject({ message: expect.stringMatching(message) }); } }
async function snapshots(prefix: string, render: (material: PrimitiveMaterialVariant, angle: PrimitiveCameraAngle) => Promise<Uint8Array>): Promise<void> { const pngs: Record<string, Uint8Array> = {}; for (const material of MATERIALS) for (const angle of ANGLES) { const name = `${prefix}-${material}-${angle}.png`; pngs[name] = await render(material, angle); } assertAllDistinct(pngs); for (const [name, bytes] of Object.entries(pngs)) await expectSnapshot(name, bytes); }
