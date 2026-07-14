import { expect, test } from "vitest";
import {
  degToRad,
  orthographicCamera,
  perspectiveCamera,
  type Camera,
  type Vec3,
} from "../../src/scene/geometry-src/index.ts";

const perspectiveExpected = [
  2.41421365738, 0, 0, 0,
  0, 2.41421365738, 0, 0,
  0, 0, -1.0010010004, -1,
  0, 0, 4.90490484238, 5,
];

const orthographicExpected = [
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, -0.0100100096315, 0,
  0, 0, 0.0490490458906, 1,
];

function vec3(values: [number, number, number]): Vec3 {
  return new Float32Array(values) as Vec3;
}

function expectMatrixCloseTo(actual: ArrayLike<number>, expected: number[]): void {
  expect(actual.length).toBe(16);

  for (const [index, value] of expected.entries()) {
    expect(actual[index]).toBeCloseTo(value, 6);
  }
}

function expectCameraFieldsFrozen(cam: Camera): void {
  expect(() => {
    (cam as { viewProjectionMatrix: unknown }).viewProjectionMatrix = new Float32Array(16);
  }).toThrow(TypeError);

  expect(() => {
    (cam as { position: unknown }).position = new Float32Array([1, 2, 3]);
  }).toThrow(TypeError);
}

test("perspectiveCamera produces 16-element view-projection matrix for fixed pose", () => {
  const cam = perspectiveCamera({
    fovYRadians: degToRad(45),
    aspect: 1,
    near: 0.1,
    far: 100,
    position: vec3([0, 0, 5]),
    target: vec3([0, 0, 0]),
  });

  expectMatrixCloseTo(cam.viewProjectionMatrix, perspectiveExpected);
  expect(Array.from(cam.position)).toEqual([0, 0, 5]);
});

test("orthographicCamera produces 16-element view-projection matrix for fixed pose", () => {
  const cam = orthographicCamera({
    left: -1,
    right: 1,
    bottom: -1,
    top: 1,
    near: 0.1,
    far: 100,
    position: vec3([0, 0, 5]),
    target: vec3([0, 0, 0]),
  });

  expectMatrixCloseTo(cam.viewProjectionMatrix, orthographicExpected);
  expect(Array.from(cam.position)).toEqual([0, 0, 5]);
});

test("cameras returned objects are immutable for view-projection matrix and position", () => {
  const perspective = perspectiveCamera({
    fovYRadians: degToRad(45),
    aspect: 1,
    near: 0.1,
    far: 100,
    position: vec3([0, 0, 5]),
    target: vec3([0, 0, 0]),
  });
  const orthographic = orthographicCamera({
    left: -1,
    right: 1,
    bottom: -1,
    top: 1,
    near: 0.1,
    far: 100,
    position: vec3([0, 0, 5]),
    target: vec3([0, 0, 0]),
  });

  expectCameraFieldsFrozen(perspective);
  expectCameraFieldsFrozen(orthographic);
});

test("perspectiveCamera with default up returns same matrix as explicit up [0, 1, 0]", () => {
  const base = {
    fovYRadians: degToRad(45),
    aspect: 1,
    near: 0.1,
    far: 100,
    position: vec3([0, 0, 5]),
    target: vec3([0, 0, 0]),
  };

  const defaultUp = perspectiveCamera(base);
  const explicitUp = perspectiveCamera({ ...base, up: vec3([0, 1, 0]) });

  expectMatrixCloseTo(defaultUp.viewProjectionMatrix, Array.from(explicitUp.viewProjectionMatrix));
});
