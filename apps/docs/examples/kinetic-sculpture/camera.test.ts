import { expect, test } from 'vitest';

import { createCamera, DEFAULT_VIEW, fitDistance, orbitBy, PITCH_LIMITS, resetView, updateCamera, ZOOM_LIMITS, zoomBy } from './camera';

const frame = { center: [0, 2, 0], extent: [1.6, 2.4] as const };

test('the fit backs away for tall or portrait frames', () => {
  const landscape = fitDistance(frame.extent, 32, 16 / 9);
  // In portrait the width binds (cropped a little), so the camera backs away.
  const wide = [2.4, 2.4] as const;
  expect(fitDistance(wide, 32, 9 / 16)).toBeGreaterThan(fitDistance(wide, 32, 16 / 9));
  expect(fitDistance([1.6, 3.6], 32, 16 / 9)).toBeGreaterThan(landscape);
  // A narrower lens needs more distance for the same box.
  expect(fitDistance(frame.extent, 24, 16 / 9)).toBeGreaterThan(landscape);
});

test('orbit and zoom stay inside their limits, and reset restores the default view', () => {
  const camera = createCamera();
  orbitBy(camera, 0.5, 10);
  expect(camera.goal.pitch).toBeCloseTo(PITCH_LIMITS.maxPitch);
  orbitBy(camera, 0, -10);
  expect(camera.goal.pitch).toBeCloseTo(PITCH_LIMITS.minPitch);
  for (let step = 0; step < 40; step++) zoomBy(camera, 0.5);
  expect(camera.zoom).toBe(ZOOM_LIMITS.min);
  for (let step = 0; step < 40; step++) zoomBy(camera, 2);
  expect(camera.zoom).toBe(ZOOM_LIMITS.max);
  resetView(camera);
  expect([camera.goal.yaw, camera.goal.pitch, camera.zoom]).toEqual([DEFAULT_VIEW.yaw, DEFAULT_VIEW.pitch, DEFAULT_VIEW.zoom]);
});

test('dt 0 snaps to the goal; a positive dt eases toward it', () => {
  const camera = createCamera();
  updateCamera(camera, frame, 16 / 9, 0);
  const fitted = fitDistance(frame.extent, camera.lens.fov, 16 / 9);
  expect(camera.current.distance).toBeCloseTo(fitted);
  expect(Array.from(camera.current.target)).toEqual(frame.center);

  orbitBy(camera, 1, 0);
  updateCamera(camera, frame, 16 / 9, 1 / 60);
  expect(camera.current.yaw).toBeGreaterThan(DEFAULT_VIEW.yaw);
  expect(camera.current.yaw).toBeLessThan(camera.goal.yaw);
  const matrices = updateCamera(camera, frame, 16 / 9, 0);
  expect(camera.current.yaw).toBeCloseTo(camera.goal.yaw);
  expect(matrices.viewProjection.every(Number.isFinite)).toBe(true);
});
