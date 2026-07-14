import type { Device } from "@vgpu/core";
import { init as initMock } from "../../../src/mock.ts";
import { init as initNode } from "../../../src/node.ts";
import { type MeshPrimitive } from "../../../src/scene/geometry-src/index.ts";
import { expect } from "vitest";
import { assertAllDistinct, expectSnapshot, primitiveCamera, renderPrimitiveFrame, type PrimitiveCameraAngle, type PrimitiveMaterialVariant } from "./_helpers.ts";

export interface PolyhedronCase {
  readonly name: string;
  readonly vertexCount: number;
  readonly normalCount: number;
  readonly create: (device: Device, radius: number) => MeshPrimitive;
}

const ANGLES: readonly PrimitiveCameraAngle[] = ["front", "iso", "side"];
const MATERIALS: readonly PrimitiveMaterialVariant[] = ["pbr", "normalDebug32"];

export async function expectPolyhedronBasics(testCase: PolyhedronCase): Promise<void> {
  const { device } = await initMock();
  const radius = 2;
  const mesh = testCase.create(device, radius);
  expect(mesh.vertexCount).toBe(testCase.vertexCount);
  expect(mesh.indexCount).toBe(testCase.vertexCount);
  expect(mesh.indexFormat).toBe("uint16");
  expect(mesh.attributes.stride).toBe(32);
  expect(mesh.layout).toBe("position-normal-uv");
  expect(mesh.gpu.vertexBuffer).toBeDefined();
  expect(mesh.gpu.indexBuffer).toBeDefined();
  for (let i = 0; i < 3; i++) {
    expect(mesh.bbox.min[i]).toBeCloseTo(-radius, 5);
    expect(mesh.bbox.max[i]).toBeCloseTo(radius, 5);
  }
  const vertices = new Float32Array(await mesh.vertexBuffer.read(mesh.vertexCount * 32));
  expectVertexData(vertices, mesh.vertexCount, radius, testCase.normalCount);
  expect(testCase.create(device, radius)).toBe(mesh);
  expectInvalid(() => testCase.create(device, 0));
  expectInvalid(() => testCase.create(device, -1));
  device.destroy();
}

export async function expectPolyhedronSnapshots(testCase: PolyhedronCase): Promise<void> {
  const { device } = await initNode();
  const pngs: Record<string, Uint8Array> = {};
  try {
    for (const material of MATERIALS) for (const angle of ANGLES) {
      const name = `${testCase.name}-${material}-${angle}.png`;
      pngs[name] = await renderPrimitiveFrame({ device, mesh: testCase.create(device, 0.5), camera: primitiveCamera(angle), material, baseColor: [0.8, 0.7, 0.45] });
    }
    assertAllDistinct(pngs);
    for (const [name, bytes] of Object.entries(pngs)) await expectSnapshot(name, bytes);
  } finally { device.destroy(); }
}

function expectVertexData(vertices: Float32Array, vertexCount: number, radius: number, normalCount: number): void {
  const uniqueNormals = new Set<string>();
  for (let i = 0; i < vertexCount; i += 3) {
    const p0 = position(vertices, i);
    const n0 = normal(vertices, i);
    uniqueNormals.add(n0.map((v) => (Math.abs(v) < 0.00005 ? 0 : v).toFixed(4)).join("|"));
    for (let j = 0; j < 3; j++) {
      const p = position(vertices, i + j);
      const n = normal(vertices, i + j);
      expect(Math.hypot(p[0], p[1], p[2])).toBeCloseTo(radius, 5);
      expect(n[0]).toBeCloseTo(n0[0], 6);
      expect(n[1]).toBeCloseTo(n0[1], 6);
      expect(n[2]).toBeCloseTo(n0[2], 6);
    }
    expect(dot(n0, center(position(vertices, i), position(vertices, i + 1), position(vertices, i + 2)))).toBeGreaterThan(0);
  }
  expect(uniqueNormals.size).toBe(normalCount);
}

function position(vertices: Float32Array, index: number): readonly [number, number, number] { const o = index * 8; return [vertices[o]!, vertices[o + 1]!, vertices[o + 2]!]; }
function normal(vertices: Float32Array, index: number): readonly [number, number, number] { const o = index * 8 + 3; return [vertices[o]!, vertices[o + 1]!, vertices[o + 2]!]; }
function center(a: readonly [number, number, number], b: readonly [number, number, number], c: readonly [number, number, number]): readonly [number, number, number] { return [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3]; }
function dot(a: readonly [number, number, number], b: readonly [number, number, number]): number { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function expectInvalid(fn: () => unknown): void { try { fn(); throw new Error("Expected VGPU-CORE-INVALID-USAGE"); } catch (error) { expect(error).toMatchObject({ code: "VGPU-CORE-INVALID-USAGE" }); } }
