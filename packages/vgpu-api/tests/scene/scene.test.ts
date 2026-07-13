import { describe, expect, test } from "vitest";
import { getMockGPUDeviceInstrumentation } from "@vgpu/core";
import { init } from "../../src/mock.ts";
import { box, orbit, perspectiveCamera } from "../../src/scene.ts";

const SIMPLE_DRAW = `
@vertex fn vs_main(@location(0) position: vec3f, @location(1) normal: vec3f) -> @builtin(position) vec4f {
  return vec4f(position + normal * 0.0, 1.0);
}
@fragment fn fs_main() -> @location(0) vec4f { return vec4f(1.0); }
`;

describe("vgpu/scene", () => {
  test("gpu.mesh(box()) produces draw vertex-buffer layout", async () => {
    const gpu = await init({ size: [4, 4] });
    const mesh = gpu.mesh(box({ size: 2 }));
    const mock = getMockGPUDeviceInstrumentation(gpu.device.gpu);

    expect(mesh.vertexCount).toBe(36);
    expect(mesh.indexBuffer).toBeUndefined();
    expect(mesh.vertexBuffers).toHaveLength(1);
    expect(mesh.vertexBufferLayouts).toEqual([
      {
        arrayStride: 24,
        attributes: [
          { shaderLocation: 0, offset: 0, format: "float32x3" },
          { shaderLocation: 1, offset: 12, format: "float32x3" },
        ],
      },
    ]);
    expect(mock.createBufferDescriptors[0]).toMatchObject({ label: "mesh.box.size=2", size: 36 * 6 * 4 });
    gpu.dispose();
  });

  test("perspectiveCamera exposes the expected viewProjection matrix", () => {
    const camera = perspectiveCamera({ fov: 45, aspect: 2, near: 0.1, far: 50, position: [2, 2, 3], target: [0, 0, 0] });
    const projection = perspective((45 * Math.PI) / 180, 2, 0.1, 50);
    const view = lookAt([2, 2, 3], [0, 0, 0], [0, 1, 0]);
    const expected = multiply(projection, view);

    expectClose(camera.viewProjection, new Float32Array(expected));
    expect([...camera.position]).toEqual([2, 2, 3]);
  });

  test("orbit(time) returns a deterministic column-major model matrix", () => {
    expect([...orbit(Math.PI / 2)]).toEqual([
      expect.closeTo(0, 6), 0, -1, 0,
      0, 1, 0, 0,
      1, 0, expect.closeTo(0, 6), 0,
      expect.closeTo(0, 6), 0, 1, 1,
    ]);
  });

  test("gpu.pass rejects mesh options and points to gpu.draw", async () => {
    const gpu = await init({ size: [4, 4] });
    const mesh = gpu.mesh(box());
    expect(() => gpu.pass(SIMPLE_DRAW, { mesh } as never)).toThrowError(/gpu\.pass\(\) nunca acepta vertex buffers; usá gpu\.draw/);
    gpu.dispose();
  });
});


type Vec3 = readonly [number, number, number];

function perspective(fovY: number, aspect: number, near: number, far: number): number[] {
  const f = 1 / Math.tan(fovY / 2);
  const nf = 1 / (near - far);
  return [
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, far * nf, -1,
    0, 0, near * far * nf, 0,
  ];
}

function lookAt(eye: Vec3, target: Vec3, up: Vec3): number[] {
  const z = normalize([eye[0] - target[0], eye[1] - target[1], eye[2] - target[2]]);
  const x = normalize(cross(up, z));
  const y = cross(z, x);
  return [
    x[0], y[0], z[0], 0,
    x[1], y[1], z[1], 0,
    x[2], y[2], z[2], 0,
    -dot(x, eye), -dot(y, eye), -dot(z, eye), 1,
  ];
}

function multiply(a: readonly number[], b: readonly number[]): number[] {
  const out = new Array<number>(16).fill(0);
  for (let col = 0; col < 4; col++) for (let row = 0; row < 4; row++) {
    out[col * 4 + row] =
      a[0 * 4 + row]! * b[col * 4 + 0]! +
      a[1 * 4 + row]! * b[col * 4 + 1]! +
      a[2 * 4 + row]! * b[col * 4 + 2]! +
      a[3 * 4 + row]! * b[col * 4 + 3]!;
  }
  return out;
}

function normalize(v: Vec3): Vec3 {
  const len = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / len, v[1] / len, v[2] / len];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function expectClose(actual: ArrayLike<number>, expected: ArrayLike<number>): void {
  expect(actual.length).toBe(expected.length);
  for (let i = 0; i < actual.length; i++) expect(actual[i]).toBeCloseTo(expected[i]!, 5);
}
