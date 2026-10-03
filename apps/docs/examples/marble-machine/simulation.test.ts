import { expect, test } from 'vitest';

import { HOPPER_X, MACHINE_BOUNDS, MARBLE_RADIUS, RAMPS, SPAWN_Y, rampSurfaceY } from './machine';
import {
  BATCH_SIZE,
  BOUNCE_RANGE,
  FIXED_DT,
  FRAME_STEPS,
  GRAVITY,
  GRAVITY_RANGE,
  INSTANCE_CAPACITY,
  MAX_PENDING,
  MAX_STEPS_PER_FRAME,
  PRIME_STEPS,
  createSimulation,
  mulberry32,
  type Simulation,
} from './simulation';

/** A world with no scripted start and no automatic releases: only what a test drops. */
const empty = (options: Parameters<typeof createSimulation>[0] = {}) =>
  createSimulation({ primeSteps: 0, autoRelease: false, ...options });

const frames = (simulation: Simulation, count: number) => {
  for (let index = 0; index < count; index += 1) simulation.stepFrame();
};

const snapshot = (simulation: Simulation) =>
  simulation.marbles.map(({ id, palette, scale, body: { position: p, quaternion: q } }) => [id, palette, scale, p.x, p.y, p.z, q.x, q.y, q.z, q.w]);

test('mulberry32 replays the same sequence for a seed', () => {
  const a = mulberry32(7);
  const b = mulberry32(7);
  const values = Array.from({ length: 5 }, () => a());
  expect(Array.from({ length: 5 }, () => b())).toEqual(values);
  expect(values.every((value) => value >= 0 && value < 1)).toBe(true);
  expect(mulberry32(8)()).not.toBe(values[0]);
});

test('a released marble falls freely under the configured gravity', () => {
  const simulation = empty();
  simulation.release();
  expect(simulation.marbles).toHaveLength(1);
  const [marble] = simulation.marbles;
  expect(marble!.body.position.y).toBe(SPAWN_Y);
  expect(Math.abs(marble!.body.position.x - HOPPER_X)).toBeLessThan(0.031);

  // 6 steps are 0.05 s: still above the first ramp, so this is free fall from vy = -0.5.
  for (let step = 0; step < 6; step += 1) simulation.advance(FIXED_DT);
  const time = 6 * FIXED_DT;
  const expected = SPAWN_Y - 0.5 * time - 0.5 * GRAVITY * time * time;
  // Semi-implicit Euler and the 0.04 linear damping land within a centimetre of the closed form.
  expect(marble!.body.position.y).toBeCloseTo(expected, 1);
  expect(marble!.body.position.y).toBeLessThan(SPAWN_Y - 0.1);
});

test('the marble lands in the first trough and rolls down it between the rails', () => {
  const simulation = empty();
  simulation.release();
  const marble = simulation.marbles[0]!;
  const ramp = RAMPS[0]!;
  frames(simulation, 30);
  const { x, y, z } = marble.body.position;
  expect(x).toBeGreaterThan(HOPPER_X);
  expect(x).toBeLessThan(ramp.lowX);
  // Resting on the tilted floor: the centre sits one radius along its normal.
  expect(y).toBeCloseTo(rampSurfaceY(ramp, x) + MARBLE_RADIUS, 1);
  expect(Math.abs(z)).toBeLessThan(0.21 - MARBLE_RADIUS + 0.01);
  expect(marble.body.velocity.x).toBeGreaterThan(0.5);
});

test('marbles stay inside the machine and collect in the tray', () => {
  const simulation = createSimulation();
  const ids = new Set(simulation.marbles.map((marble) => marble.id));
  // 10 s of automatic releases, then 8 s for the last ones to reach the tray.
  for (let frame = 0; frame < 60 * 18; frame += 1) {
    if (frame === 60 * 10) simulation.autoRelease = false;
    simulation.stepFrame();
    for (const { id, body } of simulation.marbles) {
      ids.add(id);
      const { x, y, z } = body.position;
      expect(x).toBeGreaterThan(MACHINE_BOUNDS.min[0]);
      expect(x).toBeLessThan(MACHINE_BOUNDS.max[0]);
      expect(y).toBeGreaterThan(MACHINE_BOUNDS.min[1]);
      expect(y).toBeLessThan(MACHINE_BOUNDS.max[1]);
      expect(z).toBeGreaterThan(MACHINE_BOUNDS.min[2]);
      expect(z).toBeLessThan(MACHINE_BOUNDS.max[2]);
    }
  }
  // Every release is still live (CAPACITY 40 was never reached), so nothing escaped the world.
  expect(simulation.marbles.length).toBe(ids.size);
  expect(ids.size).toBeGreaterThan(18);
  const inTray = simulation.marbles.filter(({ body: { position } }) => position.y < 0.5 && position.z > -0.24);
  expect(inTray).toHaveLength(simulation.marbles.length);
  // The catch settles against the front lip.
  const moving = inTray.filter(({ body }) => body.velocity.length() > 0.3);
  expect(moving.length).toBeLessThanOrEqual(2);
});

test('the scripted start leaves several marbles on the ramps with auto release off', () => {
  const simulation = createSimulation({ autoRelease: false, paused: true });
  expect(simulation.steps).toBe(PRIME_STEPS);
  expect(simulation.pendingReleases).toBe(0);
  const onRamps = simulation.marbles.filter(({ body: { position } }) => position.y > 0.6);
  const inTray = simulation.marbles.filter(({ body: { position } }) => position.y < 0.5);
  expect(onRamps.length).toBeGreaterThanOrEqual(3);
  expect(inTray.length).toBeGreaterThanOrEqual(3);
});

test('pause stops advance, single steps still move one frame, and reset replays the same run', () => {
  const simulation = createSimulation();
  const start = snapshot(simulation);
  simulation.paused = true;
  expect(simulation.advance(0.05)).toBe(0);
  expect(simulation.steps).toBe(PRIME_STEPS);
  simulation.stepFrame();
  expect(simulation.steps).toBe(PRIME_STEPS + FRAME_STEPS);
  frames(simulation, 89);
  simulation.releaseBatch(3);
  frames(simulation, 120);
  const after = snapshot(simulation);
  expect(after).not.toEqual(start);

  simulation.reset();
  expect(simulation.steps).toBe(PRIME_STEPS);
  expect(snapshot(simulation)).toEqual(start);
  frames(simulation, 90);
  simulation.releaseBatch(3);
  frames(simulation, 120);
  // Same engine, same inputs: the replay matches exactly. Across engines and CPUs it agrees
  // only within floating-point tolerance, which this test does not claim.
  expect(snapshot(simulation)).toEqual(after);

  // An independent world with the same seed agrees too; a different seed does not.
  const twin = createSimulation({ paused: true });
  expect(snapshot(twin)).toEqual(start);
  expect(snapshot(createSimulation({ seed: 1, paused: true }))).not.toEqual(start);
});

test('advance runs bounded fixed steps from wall-clock time', () => {
  const simulation = empty();
  expect(simulation.advance(0)).toBe(0);
  expect(simulation.advance(Number.NaN)).toBe(0);
  expect(simulation.advance(-1)).toBe(0);
  // A long hitch is clamped to MAX_FRAME_DELTA = 6 steps, not replayed.
  expect(simulation.advance(2)).toBe(MAX_STEPS_PER_FRAME);
  let taken = 0;
  for (let frame = 0; frame < 60; frame += 1) taken += simulation.advance(1 / 60);
  expect(taken).toBeGreaterThanOrEqual(119);
  expect(taken).toBeLessThanOrEqual(121);
});

test('capacity recycles the oldest marble and instances stay within INSTANCE_CAPACITY', () => {
  const capacity = 6;
  const simulation = empty({ capacity });
  const seen: number[] = [];
  for (let frame = 0; frame < 60 * 14; frame += 1) {
    if (frame % 20 === 0) simulation.release();
    simulation.stepFrame();
    const active = simulation.marbles.filter((marble) => marble.retiredAt < 0);
    expect(active.length).toBeLessThanOrEqual(capacity);
    expect(simulation.marbles.length).toBeLessThanOrEqual(INSTANCE_CAPACITY);
    for (const marble of simulation.marbles) {
      if (!seen.includes(marble.id)) seen.push(marble.id);
      if (marble.retiredAt >= 0) expect(marble.scale).toBeLessThan(1);
    }
  }
  // Ids are never reused within a run and keep increasing.
  expect(seen).toEqual([...seen].sort((a, b) => a - b));
  expect(seen.length).toBeGreaterThan(capacity * 3);
  // Recycled marbles shrink away and leave the world within RETIRE_STEPS.
  expect(simulation.marbles.length).toBeLessThanOrEqual(capacity + 2);
  expect(simulation.world.bodies.length).toBe(simulation.parts.length + simulation.marbles.length);
});

test('the hopper feeds a batch one marble at a time without jamming', () => {
  const simulation = empty();
  simulation.releaseBatch();
  simulation.releaseBatch();
  expect(simulation.marbles).toHaveLength(1);
  expect(simulation.pendingReleases).toBe(2 * BATCH_SIZE - 1);
  let peakInHopper = 0;
  let frame = 0;
  for (; frame < 60 * 12 && simulation.pendingReleases > 0; frame += 1) {
    simulation.stepFrame();
    const inHopper = simulation.marbles.filter(({ body: { position } }) => position.y > RAMPS[0]!.highY && Math.abs(position.x - HOPPER_X) < 0.2);
    peakInHopper = Math.max(peakInHopper, inHopper.length);
  }
  expect(simulation.pendingReleases).toBe(0);
  expect(simulation.marbles).toHaveLength(2 * BATCH_SIZE);
  expect(frame).toBeLessThan(60 * 8);
  expect(peakInHopper).toBe(1);
});

test('mashing the batch button queues at most MAX_PENDING releases', () => {
  const simulation = empty();
  for (let press = 0; press < 10; press += 1) simulation.releaseBatch();
  expect(simulation.pendingReleases).toBe(MAX_PENDING);
  for (let press = 0; press < 10; press += 1) simulation.release();
  expect(simulation.pendingReleases).toBe(MAX_PENDING);
});

test('a batch released while paused shows its first marble at once and waits for the clock', () => {
  const simulation = empty({ paused: true });
  simulation.releaseBatch();
  expect(simulation.marbles).toHaveLength(1);
  expect(simulation.advance(1)).toBe(0);
  expect(simulation.marbles).toHaveLength(1);
  frames(simulation, 60);
  expect(simulation.marbles.length).toBeGreaterThan(1);
});

test('auto release keeps feeding the machine and can be switched off', () => {
  const simulation = createSimulation({ primeSteps: 0 });
  frames(simulation, 60 * 5);
  const released = simulation.marbles.length;
  expect(released).toBeGreaterThanOrEqual(3);
  simulation.autoRelease = false;
  frames(simulation, 60 * 5);
  expect(simulation.marbles.length).toBe(released);
  simulation.autoRelease = true;
  simulation.stepFrame();
  expect(simulation.marbles.length).toBe(released + 1);
});

test('gravity and bounce are clamped to their ranges and survive reset', () => {
  const simulation = empty();
  simulation.setGravityScale(5);
  expect(simulation.gravityScale).toBe(GRAVITY_RANGE[1]);
  expect(simulation.world.gravity.y).toBeCloseTo(-GRAVITY * GRAVITY_RANGE[1]);
  simulation.setGravityScale(0);
  expect(simulation.gravityScale).toBe(GRAVITY_RANGE[0]);
  simulation.setBounce(-1);
  expect(simulation.bounce).toBe(BOUNCE_RANGE[0]);
  simulation.setBounce(3);
  expect(simulation.bounce).toBe(BOUNCE_RANGE[1]);
  const contactRestitution = () => simulation.world.contactmaterials.map((material) => material.restitution);
  const bouncy = contactRestitution();
  expect(Math.max(...bouncy)).toBeLessThanOrEqual(0.9);
  simulation.reset();
  expect(simulation.world.gravity.y).toBeCloseTo(-GRAVITY * GRAVITY_RANGE[0]);
  expect(contactRestitution()).toEqual(bouncy);
  expect(createSimulation({ primeSteps: 0, gravityScale: 9, bounce: -2 })).toMatchObject({ gravityScale: GRAVITY_RANGE[1], bounce: BOUNCE_RANGE[0] });
});

test('contact parts mirror the machine layout and every collider is a static body', () => {
  const simulation = empty();
  for (const { part, body } of simulation.parts) {
    expect(part.contact).not.toBeNull();
    expect(body.mass).toBe(0);
    expect([body.position.x, body.position.y, body.position.z]).toEqual([...part.center]);
    expect([body.quaternion.x, body.quaternion.y, body.quaternion.z, body.quaternion.w]).toEqual([...part.quaternion]);
  }
  const previous = simulation.parts;
  simulation.reset();
  expect(simulation.parts).not.toBe(previous);
  expect(simulation.parts).toHaveLength(previous.length);
});

test('static colliders are broadphased with the AABB of their rotated box', () => {
  const simulation = empty();
  // The broadphase only measures static boxes against a dynamic body, so drop one marble.
  simulation.release();
  simulation.stepFrame();
  for (const { part, body } of simulation.parts) {
    const { lowerBound, upperBound } = body.aabb;
    const measured = [lowerBound.x, lowerBound.y, lowerBound.z, upperBound.x, upperBound.y, upperBound.z];
    // The constructor measures the AABB before the rotation is set; a stale box would miss contacts.
    body.updateAABB();
    expect(measured, part.name).toEqual([lowerBound.x, lowerBound.y, lowerBound.z, upperBound.x, upperBound.y, upperBound.z]);
  }
  expect(simulation.parts.some(({ part }) => part.quaternion[3] !== 1)).toBe(true);
});
