import { expect, test } from 'vitest';

import { createFrameHealthMonitor } from './frame-health';

function runFrames({
  fps,
  frames,
  rendered,
  targetFps,
}: {
  fps: number;
  frames: number;
  rendered(index: number): boolean;
  targetFps?: number;
}) {
  const monitor = createFrameHealthMonitor();
  let status;
  for (let index = 0; index < frames; index += 1) {
    status = monitor.record({ deltaMs: 1_000 / fps, active: true, rendered: rendered(index), targetFps });
  }
  return { monitor, status: status! };
}

test.each([60, 90] as const)('keeps a healthy %d Hz loop High', (fps) => {
  const { status } = runFrames({ fps, frames: fps * 3, rendered: () => true });
  expect(status.estimatedRefreshFps).toBeCloseTo(fps, 0);
  expect(status.targetFps).toBeCloseTo(fps, 0);
  expect(status.downgrade).toBe(false);
});

test('caps a stable 120 Hz display target at 90 FPS', () => {
  const { status } = runFrames({ fps: 120, frames: 360, rendered: (index) => index % 4 !== 0 });
  expect(status.estimatedRefreshFps).toBeCloseTo(120, 0);
  expect(status.targetFps).toBe(90);
  expect(status.downgrade).toBe(false);
});

test('judges an intentional 30 FPS cap against 30, not the display', () => {
  // 60 Hz callbacks, every other frame presented on purpose: 30 presented FPS is healthy.
  const { status } = runFrames({ fps: 60, frames: 240, rendered: (index) => index % 2 === 0, targetFps: 30 });
  expect(status.targetFps).toBe(30);
  expect(status.observedFps).toBeCloseTo(30, 0);
  expect(status.downgrade).toBe(false);
});

test('downgrades after two seconds below 80% of the target', () => {
  // 60 Hz callbacks but only every third frame presented: 20 FPS against a 60 target.
  const { status } = runFrames({ fps: 60, frames: 180, rendered: (index) => index % 3 === 0 });
  expect(status.downgrade).toBe(true);
  expect(status.observedFps).toBeLessThan(status.thresholdFps);
});

test('a slow device that only reaches 40 FPS on a 60 Hz display downgrades', () => {
  const { status } = runFrames({ fps: 40, frames: 120, rendered: () => true });
  expect(status.estimatedRefreshFps).toBe(60);
  expect(status.downgrade).toBe(true);
});

test('idle gaps and inactive ticks reset the window instead of counting as drops', () => {
  const monitor = createFrameHealthMonitor();
  for (let i = 0; i < 60; i += 1) monitor.record({ deltaMs: 1_000 / 60, active: true, rendered: false });
  let status = monitor.record({ deltaMs: 400, active: true, rendered: true });
  expect(status.activeWindowMs).toBe(0);
  for (let i = 0; i < 60; i += 1) monitor.record({ deltaMs: 1_000 / 60, active: true, rendered: false });
  status = monitor.record({ deltaMs: 1_000 / 60, active: false, rendered: false });
  expect(status.activeWindowMs).toBe(0);
  expect(status.downgrade).toBe(false);
});

test('never lowers the refresh estimate below the 60 Hz seed', () => {
  const { status } = runFrames({ fps: 30, frames: 30, rendered: () => true });
  expect(status.estimatedRefreshFps).toBe(60);
});

test('stays downgraded until reset', () => {
  const { monitor, status } = runFrames({ fps: 60, frames: 180, rendered: () => false });
  expect(status.downgrade).toBe(true);
  expect(monitor.record({ deltaMs: 1_000 / 60, active: true, rendered: true }).downgrade).toBe(true);
  monitor.reset();
  expect(monitor.record({ deltaMs: 1_000 / 60, active: true, rendered: true }).downgrade).toBe(false);
});
