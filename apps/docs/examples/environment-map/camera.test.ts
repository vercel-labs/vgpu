import { expect, test } from 'vitest';
import { cameraView, spinMatrix } from './camera';

/**
 * The cube is rasterized with `camera.viewProjection` while the background is ray-marched
 * from the `forward/right/up` basis. If the two disagree the reflections slide off the
 * background, so every ray is projected back through the matrix it must match.
 */
test('background rays project back onto the same NDC the view-projection produces', () => {
  const view = cameraView(0.62, 0.16, 16 / 9);
  const samples: readonly [number, number][] = [[0, 0], [0.8, 0.6], [-0.9, 0.4], [0.5, -0.75]];

  for (const [x, y] of samples) {
    const direction = rayDirection(view, x, y);
    const point: [number, number, number] = [
      view.position[0] + direction[0] * 5,
      view.position[1] + direction[1] * 5,
      view.position[2] + direction[2] * 5,
    ];
    const [ndcX, ndcY] = projectToNdc(view.camera.viewProjection, point);
    expect(ndcX).toBeCloseTo(x, 5);
    expect(ndcY).toBeCloseTo(y, 5);
  }
});

test('the camera basis stays orthonormal across the pitch range', () => {
  for (const pitch of [-1.6, -0.4, 0, 0.5, 1.6]) {
    const view = cameraView(1.1, pitch, 1);
    expect(length(view.forward)).toBeCloseTo(1, 6);
    expect(length(view.right)).toBeCloseTo(1, 6);
    expect(length(view.up)).toBeCloseTo(1, 6);
    expect(dot(view.forward, view.right)).toBeCloseTo(0, 6);
    expect(dot(view.forward, view.up)).toBeCloseTo(0, 6);
    expect(dot(view.right, view.up)).toBeCloseTo(0, 6);
    // Pitch is clamped, so the camera never flips over the pole.
    expect(Math.abs(view.position[1])).toBeLessThan(3.2);
  }
});

test('the cube spin stays a pure rotation so normals need no inverse-transpose', () => {
  const model = spinMatrix(2.1);
  const columns: readonly [number, number, number][] = [
    [model[0], model[1], model[2]],
    [model[4], model[5], model[6]],
    [model[8], model[9], model[10]],
  ];
  for (const column of columns) expect(length(column)).toBeCloseTo(1, 6);
  expect(dot(columns[0], columns[1])).toBeCloseTo(0, 6);
  expect(dot(columns[0], columns[2])).toBeCloseTo(0, 6);
  expect(dot(columns[1], columns[2])).toBeCloseTo(0, 6);
  expect([model[12], model[13], model[14], model[15]]).toEqual([0, 0, 0, 1]);
});

type Vec3 = readonly [number, number, number];

function rayDirection(view: ReturnType<typeof cameraView>, ndcX: number, ndcY: number): Vec3 {
  const x = ndcX * view.tanHalfFov * view.aspect;
  const y = ndcY * view.tanHalfFov;
  return normalize([
    view.forward[0] + view.right[0] * x + view.up[0] * y,
    view.forward[1] + view.right[1] * x + view.up[1] * y,
    view.forward[2] + view.right[2] * x + view.up[2] * y,
  ]);
}

/** Column-major mat4 times a point, then the perspective divide. */
function projectToNdc(m: Float32Array, p: Vec3): [number, number] {
  const x = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12];
  const y = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13];
  const w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
  return [x / w, y / w];
}

function normalize(v: Vec3): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function length(v: Vec3): number {
  return Math.hypot(v[0], v[1], v[2]);
}
