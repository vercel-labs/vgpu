import { describe, expect, test } from "vitest";
import { group, orthographicCamera, perspectiveCamera, type SceneCamera } from "../../../src/scene.ts";

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
  for (let i = 0; i < actual.length; i++) expect(actual[i]).toBeCloseTo(expected[i]!, 4);
}

function errorCode(fn: () => void): string | undefined {
  try {
    fn();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
}

function expectedViewProjection(fovDeg: number, aspect: number, near: number, far: number, eye: Vec3, target: Vec3): number[] {
  return multiply(perspective((fovDeg * Math.PI) / 180, aspect, near, far), lookAt(eye, target, [0, 1, 0]));
}

describe("stateful scene cameras", () => {
  test("perspectiveCamera keeps the snapshot-era matrix for a fixed pose", () => {
    const camera = perspectiveCamera({ fov: 45, aspect: 2, near: 0.1, far: 50, position: [2, 2, 3], target: [0, 0, 0] });
    expectClose(camera.viewProjection, expectedViewProjection(45, 2, 0.1, 50, [2, 2, 3], [0, 0, 0]));
    expect([...camera.position]).toEqual([2, 2, 3]);
    expect(camera.viewProjectionMatrix).toBe(camera.viewProjection);
  });

  test("set() updates matrices in place with stable identity", () => {
    const camera = perspectiveCamera({ fov: 45, aspect: 1, position: [0, 0, 5], target: [0, 0, 0] });
    const matrix = camera.viewProjection;

    camera.set({ fov: 60, position: [0, 0, 8] });
    camera.lookAt([0, 0, 0]);

    expect(camera.viewProjection).toBe(matrix);
    expectClose(matrix, expectedViewProjection(60, 1, 0.1, 100, [0, 0, 8], [0, 0, 0]));
  });

  test("a camera parented to a transformed group sees through the parent transform", () => {
    const rig = group({ position: [0, 0, 2] });
    const camera = perspectiveCamera({ fov: 45, aspect: 1, position: [0, 0, 3] });
    rig.add(camera);
    camera.lookAt([0, 0, 0]);

    expectClose(camera.viewProjection, expectedViewProjection(45, 1, 0.1, 100, [0, 0, 5], [0, 0, 0]));

    rig.set({ position: [0, 0, 4] });
    expectClose(camera.viewProjection, expectedViewProjection(45, 1, 0.1, 100, [0, 0, 7], [0, 0, 0]));
  });

  test("orthographicCamera projection reacts to set()", () => {
    const camera = orthographicCamera({ left: -1, right: 1, bottom: -1, top: 1, position: [0, 0, 5], target: [0, 0, 0] });
    const before = Array.from(camera.viewProjection);

    camera.set({ left: -2, right: 2 });
    expect(camera.viewProjection[0]).toBeCloseTo(before[0]! / 2, 5);
  });

  test("cameras satisfy the SceneCamera contract", () => {
    const cameras: SceneCamera[] = [
      perspectiveCamera({ fov: 45, position: [0, 0, 5], target: [0, 0, 0] }),
      orthographicCamera({ left: -1, right: 1, bottom: -1, top: 1, position: [0, 0, 5], target: [0, 0, 0] }),
    ];
    for (const camera of cameras) {
      expect(camera.viewProjection).toHaveLength(16);
      expect(camera.view).toHaveLength(16);
      expect(camera.projection).toHaveLength(16);
      expect([...camera.worldPosition]).toEqual([0, 0, 5]);
    }
  });

  test("projection parameters are validated", () => {
    expect(errorCode(() => perspectiveCamera({ fov: 0, position: [0, 0, 5] }))).toBe("VGPU-SCENE-VALUE-INVALID");
    expect(errorCode(() => perspectiveCamera({ fov: 45, near: 1, far: 0.5 }))).toBe("VGPU-SCENE-VALUE-INVALID");
    const camera = perspectiveCamera({ fov: 45 });
    expect(errorCode(() => camera.set({ fov: 200 }))).toBe("VGPU-SCENE-VALUE-INVALID");
  });

  test("aspect defaults to 1 until set explicitly", () => {
    const camera = perspectiveCamera({ fov: 45 });
    expect(camera.aspect).toBe(1);
    camera.set({ aspect: 16 / 9 });
    expect(camera.aspect).toBeCloseTo(16 / 9, 6);
  });
});
