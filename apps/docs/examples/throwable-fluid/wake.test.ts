import { expect, test } from 'vitest';

import type { Contact, TrackedOrb } from './orb-tracker';
import { createWake, SPLASH_FRAMES } from './wake';

const DT = 1 / 60;

function orb(overrides: Partial<TrackedOrb> = {}): TrackedOrb {
  return {
    center: [400, 300],
    previous: [390, 300],
    velocity: [600, 0],
    speed: 600,
    radius: 60,
    radii: [60, 60],
    lift: 0,
    contacts: [],
    ...overrides,
  };
}

const wall = (speed: number): Contact => ({ point: [800, 300], normal: [-1, 0], speed });

test('the stroke follows the swept segment and drags harder the faster the orb moves', () => {
  const wake = createWake();
  const moving = wake.update({ orb: orb(), dt: DT, ripples: 0, gain: 1 });
  expect(moving.orb).toMatchObject({ from: [390, 300], to: [400, 300], velocity: [600, 0], visible: true });
  expect(moving.splash).toBeNull();
  const resting = wake.update({ orb: orb({ previous: [400, 300], velocity: [0, 0], speed: 0 }), dt: DT, ripples: 0, gain: 1 });
  expect(resting.drag).toBeGreaterThan(0);
  expect(resting.drag).toBeLessThan(moving.drag);
});

test('the palette advances with distance travelled as well as time', () => {
  const still = createWake();
  const moving = createWake();
  const at = orb({ previous: [400, 300] });
  const a = still.update({ orb: at, dt: DT, ripples: 0, gain: 1 }).phase;
  const b = moving.update({ orb: orb({ previous: [260, 300] }), dt: DT, ripples: 0, gain: 1 }).phase;
  expect(a).toBeGreaterThan(0);
  expect(b).toBeGreaterThan(a);
});

test('a wall contact splashes for a few frames: a jet off the wall, ink scaled by impact speed', () => {
  const wake = createWake();
  const hard = wake.update({ orb: orb({ contacts: [wall(300), wall(1600)] }), dt: DT, ripples: 0, gain: 1 }).splash!;
  // The strongest contact wins; its jet points back into the field along the normal.
  expect(hard.jet[0]).toBeLessThan(0);
  expect(hard.jet[1]).toBe(0);
  expect(hard.arms).toBe(0);
  expect(hard.point[0]).toBeLessThan(800);
  for (let i = 1; i < SPLASH_FRAMES; i++) {
    expect(wake.update({ orb: orb(), dt: DT, ripples: 0, gain: 1 }).splash).toEqual(hard);
  }
  expect(wake.update({ orb: orb(), dt: DT, ripples: 0, gain: 1 }).splash).toBeNull();

  const soft = createWake().update({ orb: orb({ contacts: [wall(300)] }), dt: DT, ripples: 0, gain: 1 }).splash!;
  expect(Math.abs(soft.jet[0])).toBeLessThan(Math.abs(hard.jet[0]));
  expect(soft.amount).toBeLessThan(hard.amount);

  // Reduced motion splashes more gently.
  const gentle = createWake().update({ orb: orb({ contacts: [wall(1600)] }), dt: DT, ripples: 0, gain: 0.5 }).splash!;
  expect(gentle.amount).toBeCloseTo(hard.amount / 2, 6);
});

test('ripples lay ink arms round the orb and alternate their spin', () => {
  const wake = createWake();
  const first = wake.update({ orb: orb(), dt: DT, ripples: 1, gain: 1 }).splash!;
  expect(first.point).toEqual([400, 300]);
  expect(first.arms).toBeGreaterThan(0);
  expect(first.jet).toEqual([0, 0]);
  for (let i = 1; i < SPLASH_FRAMES; i++) wake.update({ orb: orb(), dt: DT, ripples: 0, gain: 1 });
  const second = wake.update({ orb: orb(), dt: DT, ripples: 1, gain: 1 }).splash!;
  expect(Math.sign(second.swirl)).toBe(-Math.sign(first.swirl));
  expect(second.turn).not.toBe(first.turn);
});

test('a hidden orb stirs nothing', () => {
  const frame = createWake().update({ orb: null, dt: DT, ripples: 1, gain: 1 });
  expect(frame.orb.visible).toBe(false);
  expect(frame.splash).toBeNull();
  expect(frame.drag).toBe(0);
});
