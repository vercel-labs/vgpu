import { expect, test } from 'vitest';

import { createOrbTracker, SPLASH_SPEED, type TrackerInput } from './orb-tracker';

const CANVAS = { left: 20, top: 10, width: 800, height: 600 };
const DT = 1 / 60;

/** The orb centred at (x, y) canvas px with a 60 px layout radius. */
function input(x: number, y: number, scale = 1): TrackerInput {
  const radius = 60 * scale;
  return {
    orb: { left: CANVAS.left + x - radius, top: CANVAS.top + y - radius, width: radius * 2, height: radius * 2 },
    bounds: CANVAS,
    canvas: CANVAS,
    scale,
  };
}

test('reports the centre, its swept segment and the velocity relative to the canvas', () => {
  const tracker = createOrbTracker();
  const first = tracker.update(input(200, 300), DT);
  expect(first.center).toEqual([200, 300]);
  // No previous frame: no segment, no velocity.
  expect(first.previous).toEqual([200, 300]);
  expect(first.speed).toBe(0);

  const second = tracker.update(input(210, 295), DT);
  expect(second.previous).toEqual([200, 300]);
  expect(second.center).toEqual([210, 295]);
  expect(second.velocity[0]).toBeCloseTo(600, 6);
  expect(second.velocity[1]).toBeCloseTo(-300, 6);
  expect(second.radii).toEqual([60, 60]);
  expect(second.contacts).toEqual([]);
});

test('the press scale lifts the orb', () => {
  const tracker = createOrbTracker();
  expect(tracker.update(input(200, 300, 1), DT).lift).toBe(0);
  const lifted = tracker.update(input(200, 300, 1.12), DT);
  expect(lifted.lift).toBeCloseTo(1, 6);
  expect(lifted.radius).toBeCloseTo(67.2, 6);
});

test('crossing a wall fast splashes once, with the normal into the field', () => {
  const tracker = createOrbTracker();
  tracker.update(input(720, 300), DT);
  // 30 px in one frame, 1800 px/s, carries the layout box 10 px past the right wall.
  const hit = tracker.update(input(750, 300), DT);
  expect(hit.contacts).toHaveLength(1);
  const [contact] = hit.contacts;
  expect(contact!.normal).toEqual([-1, 0]);
  expect(contact!.point[0]).toBe(800);
  expect(contact!.speed).toBeCloseTo(1800, 6);

  // Still past the wall on the next frame: no second splash.
  expect(tracker.update(input(752, 300), DT).contacts).toEqual([]);
});

test('a slow touch of the wall does not splash', () => {
  const tracker = createOrbTracker();
  const step = (SPLASH_SPEED * 0.5) * DT;
  tracker.update(input(740 - step / 2, 300), DT);
  expect(tracker.update(input(740 + step / 2, 300), DT).contacts).toEqual([]);
});

test('past a wall the lens flattens against it and bulges along it', () => {
  const tracker = createOrbTracker();
  tracker.update(input(300, 500), DT);
  const squashed = tracker.update(input(300, 580), DT);
  // The element is 40 px past the bottom wall; the lens stays inside, touching it.
  expect(squashed.radii[1]).toBeLessThan(60);
  expect(squashed.radii[0]).toBeGreaterThan(60);
  expect(squashed.center[1] + squashed.radii[1]).toBeCloseTo(600, 6);
  expect(squashed.contacts[0]?.normal).toEqual([0, -1]);
});

test('bounds that move (a resize) reset the velocity instead of reporting a jump', () => {
  const tracker = createOrbTracker();
  tracker.update(input(200, 300), DT);
  const moved = tracker.update({ ...input(400, 300), bounds: { ...CANVAS, width: 700 } }, DT);
  expect(moved.speed).toBe(0);
  expect(moved.previous).toEqual(moved.center);

  tracker.reset();
  expect(tracker.update(input(500, 300), DT).speed).toBe(0);
});
