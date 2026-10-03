import { describe, expect, test } from "vitest";
import {
  createOceanCamera,
  resizeOceanCamera,
  updateOceanCamera,
} from "./camera";
import { OCEAN_CAMERA } from "./scene";

function expectClose(actual: ArrayLike<number>, expected: ArrayLike<number>): void {
  expect(actual.length).toBe(expected.length);
  for (let index = 0; index < expected.length; index++) {
    expect(actual[index]).toBeCloseTo(expected[index]!, 5);
  }
}

describe("ocean camera", () => {
  test("reproduces the authored eye, target, lens, and aspect", () => {
    const camera = createOceanCamera({ ...OCEAN_CAMERA, aspect: 16 / 9 });

    expectClose(camera.pose.position, OCEAN_CAMERA.position);
    expectClose(camera.current.target, OCEAN_CAMERA.target);
    expectClose(camera.goal.target, OCEAN_CAMERA.target);
    expect(camera.lens).toEqual({
      fov: OCEAN_CAMERA.fov,
      near: OCEAN_CAMERA.near,
      far: OCEAN_CAMERA.far,
    });
    expect(camera.aspect).toBe(16 / 9);
    expectClose(projectNdc(camera.viewProjection, OCEAN_CAMERA.target), [0, 0]);
  });

  test("reuses matrices and updates projection after resize", () => {
    const camera = createOceanCamera({ ...OCEAN_CAMERA, aspect: 1 });
    const projection = camera.projection;
    const view = camera.view;
    const viewProjection = camera.viewProjection;
    const projectionBefore = new Float32Array(projection);
    const viewBefore = new Float32Array(view);

    resizeOceanCamera(camera, 2);

    expect(camera.aspect).toBe(2);
    expect(camera.projection).toBe(projection);
    expect(camera.view).toBe(view);
    expect(camera.viewProjection).toBe(viewProjection);
    expect(Array.from(projection)).not.toEqual(Array.from(projectionBefore));
    expectClose(view, viewBefore);
    expectClose(projectNdc(camera.viewProjection, OCEAN_CAMERA.target), [0, 0]);
  });

  test("smooths toward the app-owned goal instead of snapping", () => {
    const camera = createOceanCamera({ ...OCEAN_CAMERA, aspect: 1 });
    const startYaw = camera.current.yaw;
    const startDistance = camera.current.distance;
    camera.goal.yaw += 0.6;
    camera.goal.distance *= 0.5;

    updateOceanCamera(camera, 1 / 60);

    expect(camera.current.yaw).toBeGreaterThan(startYaw);
    expect(camera.current.yaw).toBeLessThan(camera.goal.yaw);
    expect(camera.current.distance).toBeLessThan(startDistance);
    expect(camera.current.distance).toBeGreaterThan(camera.goal.distance);

    for (let frame = 0; frame < 120; frame++) updateOceanCamera(camera, 1 / 60);
    expect(camera.current.yaw).toBeCloseTo(camera.goal.yaw, 5);
    expect(camera.current.distance).toBeCloseTo(camera.goal.distance, 5);
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
