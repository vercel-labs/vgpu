import { expect, test } from 'vitest';

import {
  DEFAULT_VIEW,
  PITCH_LIMITS,
  YAW_LIMIT,
  ZOOM_LIMITS,
  createCamera,
  createFocus,
  lightMatrices,
  orbitBy,
  resetView,
  updateCamera,
  updateFocus,
  zoomBy,
} from './camera';
import { MACHINE_BOUNDS } from './machine';
import type { Simulation } from './simulation';

function project(matrix: Float32Array, point: readonly number[]): [number, number, number] {
  const [x, y, z] = point as [number, number, number];
  const w = matrix[3]! * x + matrix[7]! * y + matrix[11]! * z + matrix[15]!;
  return [
    (matrix[0]! * x + matrix[4]! * y + matrix[8]! * z + matrix[12]!) / w,
    (matrix[1]! * x + matrix[5]! * y + matrix[9]! * z + matrix[13]!) / w,
    (matrix[2]! * x + matrix[6]! * y + matrix[10]! * z + matrix[14]!) / w,
  ];
}

const corners = Array.from({ length: 8 }, (_, corner) => [
  corner & 1 ? MACHINE_BOUNDS.max[0] : MACHINE_BOUNDS.min[0],
  corner & 2 ? MACHINE_BOUNDS.max[1] : MACHINE_BOUNDS.min[1],
  corner & 4 ? MACHINE_BOUNDS.max[2] : MACHINE_BOUNDS.min[2],
]);

/** A stand-in simulation: only what updateFocus reads. */
function marbles(...entries: Array<[id: number, x: number, y: number, retiredAt?: number]>): Simulation {
  return {
    marbles: entries.map(([id, x, y, retiredAt = -1]) => ({ id, retiredAt, body: { position: { x, y, z: 0 } } })),
  } as unknown as Simulation;
}

test.each([
  ['fullscreen', 1280 / 720],
  ['gallery frame', 832 / 468],
  ['phone', 390 / 844],
])('the machine view fits every machine corner in the %s', (_, aspect) => {
  for (const [yaw, pitch] of [
    [DEFAULT_VIEW.yaw, DEFAULT_VIEW.pitch],
    [-YAW_LIMIT, PITCH_LIMITS.minPitch],
    [YAW_LIMIT, PITCH_LIMITS.maxPitch],
  ] as const) {
    const camera = createCamera();
    camera.goal.yaw = yaw;
    camera.goal.pitch = pitch;
    updateCamera(camera, updateFocus(createFocus(), 'machine', marbles()), aspect, 0);
    let extent = 0;
    for (const corner of corners) {
      const [x, y, z] = project(camera.matrices.viewProjection, corner);
      expect(Math.abs(x)).toBeLessThanOrEqual(1);
      expect(Math.abs(y)).toBeLessThanOrEqual(1);
      expect(z).toBeGreaterThan(0);
      expect(z).toBeLessThan(1);
      extent = Math.max(extent, Math.abs(x), Math.abs(y));
    }
    // Fitted, not merely visible: the box reaches the frame edge on its tighter axis.
    expect(extent).toBeGreaterThan(0.85);
  }
});

test('orbit and zoom stay within their limits, and resetView restores the default view', () => {
  const camera = createCamera();
  orbitBy(camera, 10, 10);
  expect(camera.goal.yaw).toBe(YAW_LIMIT);
  expect(camera.goal.pitch).toBe(PITCH_LIMITS.maxPitch);
  orbitBy(camera, -20, -20);
  expect(camera.goal.yaw).toBe(-YAW_LIMIT);
  expect(camera.goal.pitch).toBe(PITCH_LIMITS.minPitch);
  for (let step = 0; step < 20; step += 1) zoomBy(camera, 0.5);
  expect(camera.zoom).toBe(ZOOM_LIMITS.min);
  for (let step = 0; step < 20; step += 1) zoomBy(camera, 2);
  expect(camera.zoom).toBe(ZOOM_LIMITS.max);
  resetView(camera);
  expect(camera.goal).toMatchObject({ yaw: DEFAULT_VIEW.yaw, pitch: DEFAULT_VIEW.pitch });
  expect(camera.zoom).toBe(DEFAULT_VIEW.zoom);
});

test('zoom scales the fitted distance and smoothing eases toward the goal', () => {
  const camera = createCamera();
  const focus = updateFocus(createFocus(), 'machine', marbles());
  updateCamera(camera, focus, 16 / 9, 0);
  const fitted = camera.current.distance;
  camera.zoom = 0.5;
  updateCamera(camera, focus, 16 / 9, 1 / 60);
  expect(camera.goal.distance).toBeCloseTo(fitted * 0.5, 5);
  expect(camera.current.distance).toBeLessThan(fitted);
  expect(camera.current.distance).toBeGreaterThan(fitted * 0.5);
  updateCamera(camera, focus, 16 / 9, 0);
  expect(camera.current.distance).toBeCloseTo(fitted * 0.5, 5);
});

test('follow mode keeps its marble until it lands, then hands over to the newest one on the ramps', () => {
  const focus = createFocus();
  updateFocus(focus, 'follow', marbles([3, -1, 3.5], [4, -2, 4.3]));
  expect(focus.followed).toBe(4);
  expect(focus.center[0]).toBeCloseTo(-2 * 0.8);
  expect(focus.center[1]).toBeCloseTo(4.0);

  // A newer marble does not steal the camera while the followed one is still rolling.
  updateFocus(focus, 'follow', marbles([3, -1, 3.4], [4, 0, 3.9], [5, -2.2, 4.6]));
  expect(focus.followed).toBe(4);

  // The followed marble reaches the tray: the newest marble still above it takes over.
  updateFocus(focus, 'follow', marbles([3, -1, 3.3], [4, 1, 0.3], [5, -2, 4.2], [6, -2.2, 4.6, 12]));
  expect(focus.followed).toBe(5);

  // Nothing left on the ramps: the whole machine.
  updateFocus(focus, 'follow', marbles([3, 1, 0.3], [4, 1.2, 0.3]));
  expect(focus.followed).toBe(-1);
  expect(Array.from(focus.halfSize)).toEqual(Array.from(createFocus().halfSize));

  updateFocus(focus, 'follow', marbles([7, -2, 4.3]));
  expect(focus.followed).toBe(7);
  updateFocus(focus, 'machine', marbles([7, -2, 4.3]));
  expect(focus.followed).toBe(-1);
  expect(Array.from(focus.center)).toEqual(Array.from(createFocus().center));
});

test('the key light frustum contains the whole machine', () => {
  const light = { view: new Float32Array(16), viewProjection: new Float32Array(16) };
  const texel = lightMatrices(light, 2048);
  for (const corner of corners) {
    const [x, y, z] = project(light.viewProjection, corner);
    expect(Math.abs(x)).toBeLessThanOrEqual(1);
    expect(Math.abs(y)).toBeLessThanOrEqual(1);
    expect(z).toBeGreaterThanOrEqual(0);
    expect(z).toBeLessThanOrEqual(1);
  }
  // About 4 mm per texel on a machine ~7 units wide.
  expect(texel).toBeGreaterThan(0.002);
  expect(texel).toBeLessThan(0.006);
});
