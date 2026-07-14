import { init as initMock } from "../../../src/mock.ts";
import { init as initNode } from "../../../src/node.ts";
import { Mesh, type MeshPrimitive } from "../../../src/scene/geometry-src/index.ts";
import { expect, test } from "vitest";
import { assertAllDistinct, expectSnapshot, primitiveCamera, renderPrimitiveFrame, type PrimitiveCameraAngle, type PrimitiveMaterialVariant } from "./_helpers.ts";

const ANGLES: readonly PrimitiveCameraAngle[] = ["front", "iso", "side"];
const MATERIALS: readonly PrimitiveMaterialVariant[] = ["pbr", "normalDebug32"];

test("Mesh.icosphere creates midpoint-cached smooth data", async () => {
  const { device } = await initMock();
  const s0 = Mesh.icosphere({ device, radius: 2, subdivisions: 0 });
  const s1 = Mesh.icosphere({ device, radius: 2, subdivisions: 1 });
  const mesh = Mesh.icosphere({ device, radius: 2 });
  expectBasics(s0, 12, 60, 2);
  expectBasics(s1, 42, 240, 2);
  expectBasics(mesh, 162, 960, 2);
  const vertices = new Float32Array(await mesh.vertexBuffer.read(mesh.vertexCount * 32));
  for (let i = 0; i < mesh.vertexCount; i++) {
    const p = position(vertices, i);
    const n = normal(vertices, i);
    const len = Math.hypot(p[0], p[1], p[2]);
    expect(len).toBeCloseTo(2, 5);
    expect(dot([p[0] / len, p[1] / len, p[2] / len], n)).toBeCloseTo(1, 5);
  }
  expect(Mesh.icosphere({ device, radius: 2 })).toBe(mesh);
  device.destroy();
});

test("Mesh.icosphere validates params and overflow", async () => {
  const { device } = await initMock();
  expectInvalid(() => Mesh.icosphere({ device, radius: 0 }));
  expectInvalid(() => Mesh.icosphere({ device, radius: 1, subdivisions: -1 }));
  expectInvalid(() => Mesh.icosphere({ device, radius: 1, subdivisions: 7 }));
  expectInvalid(() => Mesh.icosphere({ device, radius: 1, subdivisions: 6, shading: "flat" }), /uint16/);
  device.destroy();
});

test.skipIf(process.env.VGPU_DOCKER_TEST !== "1")("icosphere primitive snapshot battery matches", async () => {
  const { device } = await initNode();
  try { await snapshots("icosphere", (material, angle) => renderPrimitiveFrame({ device, mesh: Mesh.icosphere({ device, radius: 0.5, subdivisions: 2 }), camera: primitiveCamera(angle), material, baseColor: [0.5, 0.8, 0.95] })); }
  finally { device.destroy(); }
});

function expectBasics(mesh: MeshPrimitive, vertices: number, indices: number, radius: number): void { expect(mesh.vertexCount).toBe(vertices); expect(mesh.indexCount).toBe(indices); expect(mesh.indexFormat).toBe("uint16"); expect(mesh.attributes.stride).toBe(32); expect(mesh.layout).toBe("position-normal-uv"); for (let i = 0; i < 3; i++) { expect(mesh.bbox.min[i]).toBeCloseTo(-radius, 3); expect(mesh.bbox.max[i]).toBeCloseTo(radius, 3); } }
function position(vertices: Float32Array, index: number): readonly [number, number, number] { const o = index * 8; return [vertices[o]!, vertices[o + 1]!, vertices[o + 2]!]; }
function normal(vertices: Float32Array, index: number): readonly [number, number, number] { const o = index * 8 + 3; return [vertices[o]!, vertices[o + 1]!, vertices[o + 2]!]; }
function dot(a: readonly [number, number, number], b: readonly [number, number, number]): number { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function expectInvalid(fn: () => unknown, message?: RegExp): void { try { fn(); throw new Error("Expected VGPU-CORE-INVALID-USAGE"); } catch (error) { expect(error).toMatchObject({ code: "VGPU-CORE-INVALID-USAGE" }); if (message) expect(error).toMatchObject({ message: expect.stringMatching(message) }); } }
async function snapshots(prefix: string, render: (material: PrimitiveMaterialVariant, angle: PrimitiveCameraAngle) => Promise<Uint8Array>): Promise<void> { const pngs: Record<string, Uint8Array> = {}; for (const material of MATERIALS) for (const angle of ANGLES) { const name = `${prefix}-${material}-${angle}.png`; pngs[name] = await render(material, angle); } assertAllDistinct(pngs); for (const [name, bytes] of Object.entries(pngs)) await expectSnapshot(name, bytes); }
