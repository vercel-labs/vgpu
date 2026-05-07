import { createMockAdapter } from "@vgpu/adapter-mock";
import { App } from "@vgpu/core";
import { Mesh } from "@vgpu/render";
import { expect, test } from "vitest";

test("Mesh.sphere creates an indexed position-normal-uv sphere", async () => {
  const { device } = await App.create({ adapter: createMockAdapter() });

  const mesh = Mesh.sphere({ device });
  expect(mesh.vertexCount).toBe(561);
  expect(mesh.indexCount).toBe(3072);
  expect(mesh.indexFormat).toBe("uint16");
  expect(mesh.layout).toBe("position-normal-uv");
  expect(mesh.attributes.stride).toBe(32);
  expect(mesh.gpu).toEqual({ vertexBuffer: mesh.vertexBuffer.gpu, indexBuffer: mesh.indexBuffer?.gpu });

  const indices = new Uint16Array(await mesh.indexBuffer!.read(mesh.indexCount! * 2));
  expect(Math.max(...indices)).toBeLessThan(mesh.vertexCount);
  expect(Math.min(...indices)).toBeGreaterThanOrEqual(0);

  const vertices = new Float32Array(await mesh.vertexBuffer.read(mesh.vertexCount * 32));
  expect(Array.from(vertices.slice(0, 3))).toEqual([0, 0.5, 0]);
  expect(Array.from(vertices.slice(3, 6))).toEqual([0, 1, 0]);
  assertNormalMatchesPosition(vertices, 100, 0.5);

  device.destroy();
});

test("Mesh.sphere supports custom params and caches per device and params", async () => {
  const first = await App.create({ adapter: createMockAdapter() });
  const second = await App.create({ adapter: createMockAdapter() });

  const a = Mesh.sphere({ device: first.device, radius: 1, widthSegments: 8, heightSegments: 4 });
  const b = Mesh.sphere({ device: first.device, radius: 1, widthSegments: 8, heightSegments: 4 });
  const c = Mesh.sphere({ device: first.device, radius: 0.5, widthSegments: 8, heightSegments: 4 });
  const d = Mesh.sphere({ device: second.device, radius: 1, widthSegments: 8, heightSegments: 4 });

  expect(a.vertexCount).toBe(45);
  expect(a.indexCount).toBe(192);
  expect(a).toBe(b);
  expect(a).not.toBe(c);
  expect(a).not.toBe(d);

  first.device.destroy();
  second.device.destroy();
});

test("Mesh.sphere validates params with VGPU-CORE-INVALID-USAGE", async () => {
  const { device } = await App.create({ adapter: createMockAdapter() });

  expectInvalid(() => Mesh.sphere({ device, widthSegments: 2 }));
  expectInvalid(() => Mesh.sphere({ device, radius: 0 }));
  expectInvalid(() => Mesh.sphere({ device, widthSegments: 256, heightSegments: 256 }), /uint16/);

  device.destroy();
});

function assertNormalMatchesPosition(vertices: Float32Array, index: number, radius: number): void {
  const offset = index * 8;
  const px = vertices[offset]!;
  const py = vertices[offset + 1]!;
  const pz = vertices[offset + 2]!;
  const nx = vertices[offset + 3]!;
  const ny = vertices[offset + 4]!;
  const nz = vertices[offset + 5]!;
  expect(Math.hypot(nx, ny, nz)).toBeCloseTo(1, 5);
  expect(nx).toBeCloseTo(px / radius, 5);
  expect(ny).toBeCloseTo(py / radius, 5);
  expect(nz).toBeCloseTo(pz / radius, 5);
}

function expectInvalid(fn: () => unknown, message?: RegExp): void {
  try { fn(); throw new Error("Expected VGPU-CORE-INVALID-USAGE"); }
  catch (error) {
    expect(error).toMatchObject({ code: "VGPU-CORE-INVALID-USAGE" });
    if (message) expect(error).toMatchObject({ message: expect.stringMatching(message) });
  }
}
