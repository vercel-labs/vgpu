import { expect, test, vi } from 'vitest';

import {
  createOrbStore,
  DEFAULT_SETTINGS,
  flickCoast,
  inertiaOptions,
  rescaleOffset,
  THUMP,
  type OrbHandle,
} from './orb-store';

function handle(): OrbHandle {
  return { element: null, bounds: null, scale: { get: () => 1 }, flick: vi.fn() };
}

test('settings changes notify subscribers, and repeating a value does not', () => {
  const store = createOrbStore();
  const listener = vi.fn();
  const unsubscribe = store.subscribe(listener);
  expect(store.getState()).toMatchObject({ ...DEFAULT_SETTINGS, reduced: false, thrown: false });

  store.setSettings({ power: 0.9 });
  expect(store.getState().power).toBe(0.9);
  expect(listener).toHaveBeenCalledOnce();
  const state = store.getState();
  store.setSettings({ power: 0.9 });
  store.setReduced(false);
  expect(store.getState()).toBe(state);
  expect(listener).toHaveBeenCalledOnce();

  store.markThrown();
  store.markThrown();
  expect(store.getState().thrown).toBe(true);
  expect(listener).toHaveBeenCalledTimes(2);
  unsubscribe();
  store.setReduced(true);
  expect(listener).toHaveBeenCalledTimes(2);
});

test('ripples accumulate until the renderer takes them', () => {
  const store = createOrbStore();
  store.requestRipple();
  store.requestRipple();
  expect(store.takeRipples()).toBe(2);
  expect(store.takeRipples()).toBe(0);
});

test('a stale unregister does not remove the handle that replaced it', () => {
  const store = createOrbStore();
  const first = handle();
  const second = handle();
  const unregisterFirst = store.register(first);
  const unregisterSecond = store.register(second);
  unregisterFirst();
  expect(store.handle()).toBe(second);
  unregisterSecond();
  expect(store.handle()).toBeNull();
});

test('the drag transition is Motion inertia with the panel settings', () => {
  expect(inertiaOptions({ ...DEFAULT_SETTINGS, power: 0.4, timeConstant: 350 })).toEqual({
    power: 0.4,
    timeConstant: 350,
    bounceStiffness: DEFAULT_SETTINGS.bounceStiffness,
    bounceDamping: DEFAULT_SETTINGS.bounceDamping,
    restDelta: 1,
    restSpeed: 10,
  });
});

test('a flick coasts from the orb with keyframes Motion will animate', () => {
  // Motion finishes an inertia at once unless its keyframes differ.
  expect(flickCoast(300, 0, 1100, 800, 0.6)).toEqual({ keyframes: [300, 960], velocity: 1100 });
  // The impulse adds to the coast already running.
  expect(flickCoast(300, -400, 1100, 800, 0.5)).toEqual({ keyframes: [300, 650], velocity: 700 });
  // An axis without an impulse keeps its own animation.
  expect(flickCoast(300, 250, 0, 800, 0.6)).toBeNull();
});

test('a flick starts from the wall mid-bounce, and a push into a resting wall thumps it', () => {
  // Carried past the right wall by the bounce spring, a flick back starts at the wall.
  expect(flickCoast(830, 90, -1100, 800, 0.6)?.keyframes[0]).toBe(800);
  expect(flickCoast(-12, 0, 900, 800, 0.6)?.keyframes[0]).toBe(0);
  // Into the wall it rests on: a softer push past it, which Motion's bounce spring returns.
  expect(flickCoast(800, 0, 1100, 800, 0.6)).toEqual({ keyframes: [800, 800 + 1100 * THUMP * 0.6], velocity: 1100 * THUMP });
  expect(flickCoast(-3, 20, -1100, 800, 0.6)).toEqual({ keyframes: [0, -1100 * THUMP * 0.6], velocity: -1100 * THUMP });
  expect(flickCoast(800, 0, -1100, 800, 0.6)).toEqual({ keyframes: [800, 800 - 1100 * 0.6], velocity: -1100 });
});

test('a resize keeps the orb’s share of the room it can move in', () => {
  expect(rescaleOffset(300, 600, 900)).toBe(450);
  // Resting on the far wall, it stays there.
  expect(rescaleOffset(600, 600, 300)).toBe(300);
  // Past a wall mid-bounce, it lands on the wall.
  expect(rescaleOffset(640, 600, 900)).toBe(900);
  expect(rescaleOffset(-20, 600, 900)).toBe(0);
  // No room before: it sits at the start.
  expect(rescaleOffset(0, 0, 500)).toBe(0);
});
