import { Body, Box, ContactMaterial, GSSolver, Material, NaiveBroadphase, Sphere, Vec3, World } from 'cannon-es';

import { BOX_PARTS, HOPPER_X, MARBLE_RADIUS, RAMPS, SPAWN_Y, WORLD_LIMITS, type BoxPart } from './machine';

/**
 * The marble run's physics: cannon-es bodies for every contact part in
 * machine.ts plus up to CAPACITY marbles. Nothing here touches the DOM or the
 * GPU, so tests and the thumbnail drive the exact same world.
 *
 * Time only moves in fixed steps of FIXED_DT; releases are scheduled in step
 * numbers and draw from a seeded integer PRNG, so a run (and a reset) replays
 * identically on one JavaScript engine. Floating-point results may differ
 * slightly across engines and CPUs.
 */

export const FIXED_DT = 1 / 120;
export const FRAME_STEPS = 2;
export const MAX_STEPS_PER_FRAME = 6;
export const MAX_FRAME_DELTA = 0.05;
/** 9.81 m/s² in decimetres. */
export const GRAVITY = 98.1;
export const CAPACITY = 40;
/** Marbles shrinking out of the tray still occupy an instance for a moment. */
export const INSTANCE_CAPACITY = CAPACITY + 8;
export const PALETTE_COUNT = 8;
export const DEFAULT_SEED = 0x6d61726c;
export const GRAVITY_RANGE = [0.4, 1.6] as const;
export const BOUNCE_RANGE = [0, 0.7] as const;
export const DEFAULT_BOUNCE = 0.35;

const seconds = (value: number) => Math.round(value / FIXED_DT);

/** The scripted start: a train of releases simulated before the first frame. */
export const PRIME_STEPS = seconds(7.5);
const PRIME_RELEASES = 14;
const PRIME_SPACING = seconds(0.45);
const AUTO_INTERVAL = seconds(1.6);
const BATCH_SPACING = seconds(0.3);
export const BATCH_SIZE = 8;
const RETIRE_STEPS = seconds(0.3);
const HOPPER_RETRY = seconds(0.05);
/** Queued releases beyond this are dropped, so mashing the batch button cannot queue minutes of marbles. */
export const MAX_PENDING = 3 * BATCH_SIZE;
/**
 * The hopper feeds one marble at a time: a new one drops only once the previous marble has
 * rolled a diameter clear of the drop line. Stacked marbles wedge against the hopper walls
 * and jam the feed.
 */
const HOPPER_CLEAR_X = 2 * MARBLE_RADIUS + 0.03;
const HOPPER_EXIT_Y = RAMPS[0]!.highY - 0.2;

export interface Marble {
  /** Release number since the last reset; never reused within a run. */
  readonly id: number;
  readonly body: Body;
  readonly radius: number;
  readonly palette: number;
  /** Visual size factor: 1, shrinking to 0 while the marble is recycled. */
  scale: number;
  /** Step at which recycling started, or -1. */
  retiredAt: number;
}

export interface StaticPart {
  readonly part: BoxPart;
  readonly body: Body;
}

export interface SimulationOptions {
  seed?: number;
  capacity?: number;
  /** Fixed steps of scripted releases replayed by every reset (default PRIME_STEPS). */
  primeSteps?: number;
  autoRelease?: boolean;
  paused?: boolean;
  gravityScale?: number;
  bounce?: number;
}

export interface Simulation {
  /** Live marbles, oldest first. */
  readonly marbles: readonly Marble[];
  /** Static bodies in machine.ts order; replaced by reset(). */
  readonly parts: readonly StaticPart[];
  readonly world: World;
  /** Fixed steps since the last reset, priming included. */
  readonly steps: number;
  readonly capacity: number;
  readonly pendingReleases: number;
  paused: boolean;
  autoRelease: boolean;
  readonly gravityScale: number;
  readonly bounce: number;
  setGravityScale(value: number): void;
  setBounce(value: number): void;
  /** Feeds wall-clock time into the fixed-step accumulator; returns the steps taken. No-op while paused. */
  advance(deltaSeconds: number): number;
  /** Advances exactly one 1/60 s frame (FRAME_STEPS fixed steps), paused or not. */
  stepFrame(): void;
  /** Drops a marble into the hopper now, or as soon as the hopper has room. */
  release(): void;
  releaseBatch(count?: number): void;
  /** Rebuilds the world and replays the scripted start. */
  reset(): void;
}

/** mulberry32: a small 32-bit integer PRNG with a fixed seed. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp = (value: number, [min, max]: readonly [number, number]) => Math.min(max, Math.max(min, value));

export function createSimulation(options: SimulationOptions = {}): Simulation {
  const seed = options.seed ?? DEFAULT_SEED;
  const capacity = Math.max(1, Math.min(CAPACITY, options.capacity ?? CAPACITY));
  const primeSteps = options.primeSteps ?? PRIME_STEPS;
  let gravityScale = clamp(options.gravityScale ?? 1, GRAVITY_RANGE);
  let bounce = clamp(options.bounce ?? DEFAULT_BOUNCE, BOUNCE_RANGE);
  let autoRelease = options.autoRelease ?? true;
  let paused = options.paused ?? false;

  // Rebuilt by reset(); declared here so the closures below share them.
  let world!: World;
  let parts: StaticPart[] = [];
  let marbles: Marble[] = [];
  let pending: number[] = [];
  let random = mulberry32(seed);
  let steps = 0;
  let released = 0;
  let accumulator = 0;
  let nextAuto = 0;
  let priming = false;

  const marbleMaterial = new Material('marble');
  const woodMaterial = new Material('wood');
  const feltMaterial = new Material('felt');
  const brassMaterial = new Material('brass');
  const contactMaterials = {
    wood: new ContactMaterial(marbleMaterial, woodMaterial, { friction: 0.22, restitution: 0 }),
    felt: new ContactMaterial(marbleMaterial, feltMaterial, { friction: 0.7, restitution: 0 }),
    brass: new ContactMaterial(marbleMaterial, brassMaterial, { friction: 0.12, restitution: 0 }),
    marble: new ContactMaterial(marbleMaterial, marbleMaterial, { friction: 0.06, restitution: 0 }),
  };
  const partMaterials = { wood: woodMaterial, felt: feltMaterial, brass: brassMaterial };

  function applyBounce() {
    // Felt swallows most of the bounce; glass on glass and brass ring a little more than wood.
    contactMaterials.wood.restitution = bounce;
    contactMaterials.felt.restitution = bounce * 0.25;
    contactMaterials.brass.restitution = Math.min(0.85, bounce * 1.15);
    contactMaterials.marble.restitution = Math.min(0.9, bounce * 1.3);
  }

  function applyGravity() {
    world.gravity.set(0, -GRAVITY * gravityScale, 0);
    for (const marble of marbles) marble.body.wakeUp();
  }

  function build() {
    const solver = new GSSolver();
    solver.iterations = 12;
    solver.tolerance = 1e-7;
    // Box pairs: the long ramps' bounding spheres overlap almost every marble, their AABBs do not.
    // AABBs only skip pairs that cannot touch, so the contacts (and the physics) are unchanged.
    const broadphase = new NaiveBroadphase();
    broadphase.useBoundingBoxes = true;
    world = new World({ allowSleep: true, broadphase, solver });
    for (const material of Object.values(contactMaterials)) world.addContactMaterial(material);
    parts = [];
    for (const part of BOX_PARTS) {
      if (!part.contact) continue;
      const body = new Body({
        type: Body.STATIC,
        mass: 0,
        shape: new Box(new Vec3(...part.halfExtents)),
        position: new Vec3(...part.center),
        material: partMaterials[part.contact],
      });
      body.quaternion.set(...part.quaternion);
      // The constructor measured the AABB unrotated; a static body never refreshes it on its own.
      body.aabbNeedsUpdate = true;
      world.addBody(body);
      parts.push({ part, body });
    }
    marbles = [];
    pending = [];
    random = mulberry32(seed);
    steps = 0;
    released = 0;
    accumulator = 0;
    applyBounce();
    applyGravity();
  }

  function wakeAll() {
    for (const marble of marbles) marble.body.wakeUp();
  }

  function remove(marble: Marble) {
    world.removeBody(marble.body);
    marbles.splice(marbles.indexOf(marble), 1);
    wakeAll();
  }

  function retire(marble: Marble) {
    marble.retiredAt = steps;
    wakeAll();
  }

  /** Whether a marble is still in the hopper or under it on the first ramp. */
  function hopperBusy(): boolean {
    return marbles.some(({ body: { position } }) => position.y > HOPPER_EXIT_Y && Math.abs(position.x - HOPPER_X) < HOPPER_CLEAR_X);
  }

  function spawn(): boolean {
    if (hopperBusy()) return false;

    const active = marbles.filter((marble) => marble.retiredAt < 0);
    if (active.length >= capacity) retire(active[0]!);
    if (marbles.length >= INSTANCE_CAPACITY) remove(marbles.find((marble) => marble.retiredAt >= 0) ?? marbles[0]!);

    const id = released++;
    const jitterX = (random() - 0.5) * 0.06;
    const jitterZ = (random() - 0.5) * 0.06;
    // Shoemake's uniform random rotation, so each marble's stripes start at a different angle.
    const u1 = random();
    const u2 = random() * Math.PI * 2;
    const u3 = random() * Math.PI * 2;
    const body = new Body({
      mass: 1,
      shape: new Sphere(MARBLE_RADIUS),
      position: new Vec3(HOPPER_X + jitterX, SPAWN_Y, jitterZ),
      velocity: new Vec3(0.35, -0.5, 0),
      angularVelocity: new Vec3((random() - 0.5) * 4, (random() - 0.5) * 4, (random() - 0.5) * 4),
      material: marbleMaterial,
      linearDamping: 0.04,
      angularDamping: 0.06,
      allowSleep: true,
      sleepSpeedLimit: 0.25,
      sleepTimeLimit: 0.6,
    });
    body.quaternion.set(
      Math.sqrt(1 - u1) * Math.sin(u2),
      Math.sqrt(1 - u1) * Math.cos(u2),
      Math.sqrt(u1) * Math.sin(u3),
      Math.sqrt(u1) * Math.cos(u3),
    );
    world.addBody(body);
    // 5 is coprime with 8, so consecutive marbles walk through every palette.
    marbles.push({ id, body, radius: MARBLE_RADIUS, palette: (id * 5) % PALETTE_COUNT, scale: 1, retiredAt: -1 });
    return true;
  }

  function schedule(step: number) {
    if (pending.length >= MAX_PENDING) return;
    let index = pending.length;
    while (index > 0 && pending[index - 1]! > step) index--;
    pending.splice(index, 0, step);
  }

  function stepOnce() {
    while (pending.length > 0 && pending[0]! <= steps) {
      pending.shift();
      if (!spawn()) schedule(steps + HOPPER_RETRY);
    }
    if (!priming && autoRelease && steps >= nextAuto) {
      if (spawn()) nextAuto = steps + AUTO_INTERVAL;
      else nextAuto = steps + HOPPER_RETRY;
    }

    world.step(FIXED_DT);
    steps++;

    for (let index = marbles.length - 1; index >= 0; index--) {
      const marble = marbles[index]!;
      const { x, y, z } = marble.body.position;
      const outside =
        x < WORLD_LIMITS.min[0] || x > WORLD_LIMITS.max[0] ||
        y < WORLD_LIMITS.min[1] || y > WORLD_LIMITS.max[1] ||
        z < WORLD_LIMITS.min[2] || z > WORLD_LIMITS.max[2] ||
        !Number.isFinite(x + y + z);
      if (outside) {
        remove(marble);
        continue;
      }
      if (marble.retiredAt < 0) continue;
      const progress = (steps - marble.retiredAt) / RETIRE_STEPS;
      if (progress >= 1) {
        remove(marble);
        continue;
      }
      // Shrink the collider with the visual so neighbours settle into the gap.
      marble.scale = 1 - progress * progress;
      const shape = marble.body.shapes[0] as Sphere;
      shape.radius = Math.max(0.005, marble.radius * marble.scale);
      shape.updateBoundingSphereRadius();
      marble.body.updateBoundingRadius();
      marble.body.aabbNeedsUpdate = true;
      marble.body.wakeUp();
    }
  }

  function reset() {
    build();
    priming = true;
    for (let index = 0; index < PRIME_RELEASES; index++) schedule(index * PRIME_SPACING);
    for (let step = 0; step < primeSteps; step++) stepOnce();
    pending = [];
    priming = false;
    nextAuto = steps + Math.round(AUTO_INTERVAL / 2);
  }

  reset();

  return {
    get marbles() {
      return marbles;
    },
    get parts() {
      return parts;
    },
    get world() {
      return world;
    },
    get steps() {
      return steps;
    },
    capacity,
    get pendingReleases() {
      return pending.length;
    },
    get paused() {
      return paused;
    },
    set paused(value: boolean) {
      paused = value;
      accumulator = 0;
    },
    get autoRelease() {
      return autoRelease;
    },
    set autoRelease(value: boolean) {
      if (value && !autoRelease) nextAuto = steps;
      autoRelease = value;
    },
    get gravityScale() {
      return gravityScale;
    },
    get bounce() {
      return bounce;
    },
    setGravityScale(value) {
      gravityScale = clamp(value, GRAVITY_RANGE);
      applyGravity();
    },
    setBounce(value) {
      bounce = clamp(value, BOUNCE_RANGE);
      applyBounce();
    },
    advance(deltaSeconds) {
      if (paused || !(deltaSeconds > 0)) return 0;
      accumulator += Math.min(deltaSeconds, MAX_FRAME_DELTA);
      let taken = 0;
      while (accumulator >= FIXED_DT && taken < MAX_STEPS_PER_FRAME) {
        stepOnce();
        accumulator -= FIXED_DT;
        taken++;
      }
      accumulator = Math.min(accumulator, FIXED_DT);
      return taken;
    },
    stepFrame() {
      for (let step = 0; step < FRAME_STEPS; step++) stepOnce();
    },
    release() {
      if (!spawn()) schedule(steps + HOPPER_RETRY);
    },
    releaseBatch(count = BATCH_SIZE) {
      for (let index = 0; index < count; index++) schedule(steps + index * BATCH_SPACING);
      // The first marble appears immediately, even while paused.
      if (pending[0] === steps && spawn()) pending.shift();
    },
    reset,
  };
}
