import { describe, expect, test } from "vitest";
import { createCameraState, updateCameraState } from "./scene-camera";

function expectClose(actual: ArrayLike<number>, expected: ArrayLike<number>): void {
  expect(actual.length).toBe(expected.length);
  for (let index = 0; index < expected.length; index++) {
    expect(actual[index]).toBeCloseTo(expected[index]!, 5);
  }
}

describe("app-local scene camera", () => {
  test("preserves an arbitrary eye, target, up vector, and authored lens", () => {
    const camera = createCameraState({
      position: [3, 2, 4],
      target: [0.5, -0.25, 0.75],
      up: [0.25, 1, 0.5],
      fov: 37,
      aspect: 16 / 9,
      near: 0.05,
      far: 250,
    });

    expect(Array.from(camera.position)).toEqual([3, 2, 4]);
    expect(Array.from(camera.target)).toEqual([0.5, -0.25, 0.75]);
    expect(Array.from(camera.up)).toEqual([0.25, 1, 0.5]);
    expect(camera.lens).toEqual({ fov: 37, near: 0.05, far: 250 });
    expect(camera.aspect).toBe(16 / 9);

    const targetNdc = projectNdc(camera.viewProjection, camera.target);
    const upNdc = projectNdc(camera.viewProjection, [0.75, 0.75, 1.25]);
    expectClose(targetNdc, [0, 0]);
    expect(upNdc[0]).toBeCloseTo(0, 5);
    expect(upNdc[1]).toBeGreaterThan(0);
  });

  test("updates matrices in place after pose, lens, and resize changes", () => {
    const camera = createCameraState({
      position: [0, 0, 5],
      target: [0, 0, 0],
      fov: 45,
      aspect: 1,
      near: 0.1,
      far: 100,
    });
    const projection = camera.projection;
    const view = camera.view;
    const viewProjection = camera.viewProjection;
    const before = new Float32Array(viewProjection);

    updateCameraState(camera, {
      position: [2, 1, 6],
      target: [0, 0.5, 0],
      up: [0, 0.8, 0.2],
      fov: 52,
      aspect: 2,
    });

    expect(camera.projection).toBe(projection);
    expect(camera.view).toBe(view);
    expect(camera.viewProjection).toBe(viewProjection);
    expect(Array.from(viewProjection)).not.toEqual(Array.from(before));

    const fresh = createCameraState({
      position: [2, 1, 6],
      target: [0, 0.5, 0],
      up: [0, 0.8, 0.2],
      fov: 52,
      aspect: 2,
      near: 0.1,
      far: 100,
    });
    expectClose(camera.viewProjection, fresh.viewProjection);
  });
});

function projectNdc(matrix: ArrayLike<number>, point: ArrayLike<number>): [number, number] {
  const x = point[0]!;
  const y = point[1]!;
  const z = point[2]!;
  const w = matrix[3]! * x + matrix[7]! * y + matrix[11]! * z + matrix[15]!;
  return [
    (matrix[0]! * x + matrix[4]! * y + matrix[8]! * z + matrix[12]!) / w,
    (matrix[1]! * x + matrix[5]! * y + matrix[9]! * z + matrix[13]!) / w,
  ];
}
