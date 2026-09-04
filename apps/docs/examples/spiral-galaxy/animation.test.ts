import { expect, test } from 'vitest';

import { createAnimation, SETTLE_SECONDS } from './animation';
import { generateField, LAYER_FLOATS } from './field';

const field = generateField();
const step = (animation: ReturnType<typeof createAnimation>, seconds: number, dt = 1 / 60) => {
  let last = animation.update(0);
  const frames = Math.round(seconds / dt);
  for (let i = 0; i < frames; i++) last = animation.update(dt);
  return last;
};

test('the intro converges over its duration and flow only starts once visible', () => {
  const animation = createAnimation(field, { introDuration: 2 });
  // A single update is clamped to 50 ms; a half second takes thirty frames.
  expect(animation.update(0.5).intro).toBeCloseTo(0.025, 5);
  const early = step(animation, 0.5 - 0.05);
  expect(early.intro).toBeCloseTo(0.25, 3);
  expect(early.twinkleSpeed).toBe(0);
  const offsetsEarly = field.layers.map((_, i) => animation.layerData[i * LAYER_FLOATS + 3]);
  expect(offsetsEarly.every((offset) => offset === 0)).toBe(true);

  const done = step(animation, 3);
  expect(done.intro).toBe(1);
  expect(done.twinkleSpeed).toBeCloseTo(0.62, 5);
  const offsets = field.layers.map((layer, i) => ({ layer, offset: animation.layerData[i * LAYER_FLOATS + 3]! }));
  for (const { layer, offset } of offsets) {
    if (layer.isCore) expect(offset).toBe(0);
    else {
      expect(offset).toBeGreaterThan(0);
      expect(offset).toBeLessThan(1);
    }
  }
  const core = field.layers.findIndex((layer) => layer.isCore);
  expect(animation.layerData[core * LAYER_FLOATS + 6]).toBeCloseTo(1.22, 6);
  expect(animation.layerData[core * LAYER_FLOATS + 2]).not.toBe(0);
});

test('reduced motion skips the intro and freezes flow, twinkle and repel', () => {
  const animation = createAnimation(field, { reducedMotion: true });
  const frame = animation.update(1 / 60);
  expect(frame.intro).toBe(1);
  expect(frame.twinkleSpeed).toBe(0);
  animation.setPointer(0, 0, false);
  animation.update(1 / 60);
  animation.setPointer(0.2, 0.1, false);
  expect(animation.update(1 / 60).repelEnabled).toBe(0);
  expect(animation.layerData[3]).toBe(0);
});

test('drag rotation springs the root fast and the outer strokes slower, then returns', () => {
  const animation = createAnimation(field, { introDuration: 1 });
  step(animation, 1.5);
  animation.rotate(0.3, -0.6);
  expect(animation.returning).toBe(false);
  animation.update(1 / 60);
  const spinAfterOne = { ...animation.spin };
  expect(spinAfterOne.x).toBeGreaterThan(0);
  expect(spinAfterOne.x).toBeLessThan(0.3);
  expect(spinAfterOne.y).toBeLessThan(0);
  // Layer 0 has the least lag, layer 4 the most.
  const yaw = (i: number) => animation.layerData[i * LAYER_FLOATS + 1]!;
  expect(Math.abs(yaw(0))).toBeGreaterThan(Math.abs(yaw(4)));
  expect(Math.abs(yaw(0))).toBeLessThan(Math.abs(animation.spin.y));

  step(animation, 2);
  expect(animation.spin.x).toBeCloseTo(0.3, 3);
  expect(animation.spin.y).toBeCloseTo(-0.6, 3);

  animation.release();
  expect(animation.returning).toBe(true);
  expect(animation.rotation).toEqual({ x: 0, y: 0 });
  step(animation, 3);
  expect(Math.abs(animation.spin.x)).toBeLessThan(1e-3);
  expect(Math.abs(animation.spin.y)).toBeLessThan(1e-3);

  animation.settle();
  expect(animation.spin).toEqual({ x: 0, y: 0 });
});

test('rotation is clamped and faceForward can be disabled', () => {
  const clamped = createAnimation(field);
  clamped.rotate(100, -100);
  expect(clamped.rotation.x).toBeCloseTo(4 * Math.PI, 6);
  expect(clamped.rotation.y).toBeCloseTo(-4 * Math.PI, 6);
  const free = createAnimation(field, { faceForward: false });
  free.rotate(0.5, 0.5);
  free.release();
  expect(free.rotation).toEqual({ x: 0.5, y: 0.5 });
  expect(free.returning).toBe(false);
});

test('hover movement produces an impulse, resets the coast age and settles', () => {
  const animation = createAnimation(field);
  animation.update(1 / 60);
  animation.setPointer(0.1, 0.2, false);
  const first = animation.update(1 / 60);
  expect(first.repelImpulse).toBe(0);
  expect(first.repelEnabled).toBe(0);
  animation.setPointer(0.3, 0.25, false);
  const moved = animation.update(1 / 60);
  expect(moved.repelImpulse).toBe(1);
  expect(moved.repelEnabled).toBe(1);
  expect(moved.impulse[0]).toBeCloseTo(0.2, 6);
  expect(moved.impulse[1]).toBeCloseTo(0.05, 6);
  expect(moved.previous).toEqual([0.1, 0.2]);
  expect(moved.pointer).toEqual([0.3, 0.25]);
  expect(moved.repelAge).toBeCloseTo(SETTLE_SECONDS, 6);
  const next = animation.update(1 / 60);
  expect(next.repelImpulse).toBe(0);
  expect(next.repelEnabled).toBe(1);
  expect(next.repelAge).toBeCloseTo(0, 6);
  // Pressing (dragging) suspends the repel; a still pointer keeps coasting.
  animation.setPointer(0.5, 0.5, true);
  expect(animation.update(1 / 60).repelImpulse).toBe(0);
  animation.clearPointer();
  const settled = step(animation, SETTLE_SECONDS + 0.5);
  expect(settled.repelEnabled).toBe(0);
});

test('replay restarts the intro, clears rotation and flags the motion buffer', () => {
  const animation = createAnimation(field, { introDuration: 1 });
  step(animation, 2);
  animation.rotate(0.4, 0.4);
  expect(animation.motionDirty).toBe(false);
  animation.replay();
  expect(animation.motionDirty).toBe(true);
  expect(animation.rotation).toEqual({ x: 0, y: 0 });
  expect(animation.returning).toBe(true);
  expect(animation.update(0).intro).toBe(0);
  animation.acknowledgeMotion();
  expect(animation.motionDirty).toBe(false);
  animation.resetMotion();
  expect(animation.motionDirty).toBe(true);
});

test('hover repel can be switched off and on at runtime', () => {
  const animation = createAnimation(field);
  expect(animation.repelEnabled).toBe(true);
  animation.setRepel(false);
  expect(animation.repelEnabled).toBe(false);
  animation.setPointer(0.1, 0.1, false);
  animation.update(1 / 60);
  animation.setPointer(0.4, 0.1, false);
  expect(animation.update(1 / 60).repelImpulse).toBe(0);
  animation.setRepel(true);
  animation.update(1 / 60);
  animation.setPointer(0.6, 0.1, false);
  expect(animation.update(1 / 60).repelImpulse).toBe(1);
  // Reduced motion wins over the toggle.
  const reduced = createAnimation(field, { reducedMotion: true });
  reduced.setRepel(true);
  expect(reduced.repelEnabled).toBe(false);
});
