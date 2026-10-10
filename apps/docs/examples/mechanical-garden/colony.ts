// The colony: the training-ground terrain and a fixed pool of robot dogs advanced on a fixed
// timestep. Steering (wander, a shared destination, separation, tile edges) lives here; locomotion
// lives in robot.ts. Nothing here touches the DOM or the GPU.

import { clamp } from "math";
import { mulberry32, type Mulberry32 } from "math/random";

import { createRobot, placeRobot, stepRobot, type Robot } from "./robot";
import { BRUSH_RADIUS, BRUSH_STRENGTH, clampToTile, createTerrain, generate, HALF, sculpt, type Terrain } from "./terrain";

export const MAX_ROBOTS = 48;
export const FIXED_DT = 1 / 60;
/** Fixed steps run per advance() at most; the rest of a long gap is dropped, not replayed. */
export const MAX_CATCH_UP = 4;
/** Centre-to-centre distance robots keep from each other. */
export const SPACING = 1.45;
/**
 * Centre distance below which robots are pushed apart every step (moving or resting): closer, a leg
 * reaches into a neighbour's shell. resolveCrowding asks for half the overlap per step and the
 * support guard can cut that move, so robots walking into each other can press a few centimetres
 * closer (about 1.05 at worst in 12- and 48-robot runs) before the push wins.
 */
export const MIN_GAP = 1.1;
/**
 * Preferred closest centre distance between two destination slots (layoutSlots shrinks it only when
 * the slots do not fit). Robots settle anywhere within ARRIVE of their slot, so two neighbours can
 * still rest closer than MIN_GAP; they then need a small one-off push, well inside RESUME.
 */
export const SLOT_GAP = 1.27;

export type PresetName = "close-up" | "colony" | "stress";
export const PRESETS: Readonly<Record<PresetName, { readonly count: number }>> = {
  "close-up": { count: 1 },
  colony: { count: 12 },
  stress: { count: 48 },
};
export const DEFAULT_PRESET: PresetName = "colony";
export const DEFAULT_SEED = 7;

export type BrushMode = "elevate" | "lower";

export interface BrushInput {
  /** Sculpt while true (pointer held, or a keyboard/GUI hold). */
  active: boolean;
  mode: BrushMode;
  x: number;
  z: number;
  radius: number;
  /** Height change rate at the brush centre, units per second (before the mode's sign). */
  strength: number;
}

export interface Destination {
  active: boolean;
  x: number;
  z: number;
  /** Bumped when it moves or is cleared. */
  revision: number;
}

export interface Colony {
  seed: number;
  readonly terrain: Terrain;
  /** Stable robot objects; robots [0, count) are active. */
  readonly robots: readonly Robot[];
  count: number;
  paused: boolean;
  /** Speed scale in [0, 1]; reduced motion lowers it. */
  pace: number;
  /** Simulated seconds and fixed steps since the last reset. */
  time: number;
  steps: number;
  accumulator: number;
  /** Fixed steps dropped by the catch-up cap since the last reset. */
  dropped: number;
  readonly destination: Destination;
  readonly brush: BrushInput;
  /** Per robot: wander randomness and the time left idling at a reached goal. */
  readonly randoms: Mulberry32[];
  readonly idle: Float32Array;
  /**
   * Destination slots (x, z pairs), laid out once per destination, and each robot's slot index.
   * Valid while the destination is active.
   */
  readonly slots: Float32Array;
  readonly slotOf: Int16Array;
  /** Per robot x/z body push requested by resolveCrowding this step. */
  readonly push: Float32Array;
  /** Per robot: its closest approach to the current goal and the seconds since it last improved. */
  readonly progress: Float32Array;
  readonly stall: Float32Array;
  /** Slot swaps a stalled robot made with a neighbour (see unblock) since the last reset. */
  swaps: number;
}

export interface ColonyOptions {
  readonly seed?: number;
  readonly count?: number;
}

export function createColony(options: ColonyOptions = {}): Colony {
  const seed = options.seed ?? DEFAULT_SEED;
  const terrain = createTerrain(seed);
  const colony: Colony = {
    seed,
    terrain,
    robots: Array.from({ length: MAX_ROBOTS }, (_, index) => createRobot(index)),
    count: 0,
    paused: false,
    pace: 1,
    time: 0,
    steps: 0,
    accumulator: 0,
    dropped: 0,
    destination: { active: false, x: 0, z: 0, revision: 0 },
    brush: { active: false, mode: "elevate", x: 0, z: 0, radius: 0.9, strength: 0.35 },
    randoms: Array.from({ length: MAX_ROBOTS }, () => mulberry32.create(0)),
    idle: new Float32Array(MAX_ROBOTS),
    slots: new Float32Array(MAX_ROBOTS * 2),
    slotOf: new Int16Array(MAX_ROBOTS),
    push: new Float32Array(MAX_ROBOTS * 2),
    progress: new Float32Array(MAX_ROBOTS),
    stall: new Float32Array(MAX_ROBOTS),
    swaps: 0,
  };
  reset(colony, seed, options.count ?? PRESETS[DEFAULT_PRESET].count);
  return colony;
}

function robotSeed(seed: number, index: number): number {
  return (Math.imul(seed + 1, 0x9e3779b1) ^ Math.imul(index + 1, 0x85ebca77)) >>> 0;
}

/** Regenerate terrain and robots for a seed; the same seed always gives the same colony. */
export function reset(colony: Colony, seed: number, count = colony.count): void {
  colony.seed = seed;
  generate(colony.terrain, seed);
  colony.time = 0;
  colony.steps = 0;
  colony.accumulator = 0;
  colony.dropped = 0;
  colony.swaps = 0;
  colony.destination.active = false;
  colony.destination.revision++;
  colony.brush.active = false;
  for (const robot of colony.robots) robot.active = false;
  colony.count = 0;
  setCount(colony, count);
}

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const spot: [number, number] = [0, 0];

/**
 * A spawn point for robot `index`: the first sunflower slot around the centre (starting at its own)
 * that is clear of other robots, else the roomiest one tried.
 */
function spawn(colony: Colony, index: number): void {
  let best = -1;
  let bestX = 0;
  let bestZ = 0;
  for (let attempt = 0; attempt < 40; attempt++) {
    const k = (index + attempt * 7) % 64;
    const radius = 0.8 * Math.sqrt(k + 0.3);
    const angle = k * GOLDEN_ANGLE + colony.seed * 0.61;
    spot[0] = clampToTile(Math.cos(angle) * radius, 1);
    spot[1] = clampToTile(Math.sin(angle) * radius, 1);
    let room = Infinity;
    for (let other = 0; other < colony.count; other++) {
      const robot = colony.robots[other]!;
      if (other !== index && robot.active) room = Math.min(room, Math.hypot(robot.position[0] - spot[0], robot.position[2] - spot[1]));
    }
    if (room >= SPACING) return;
    if (room > best) {
      best = room;
      bestX = spot[0];
      bestZ = spot[1];
    }
  }
  spot[0] = bestX;
  spot[1] = bestZ;
}

/** Grow or shrink the active population, keeping existing robots where they are. */
export function setCount(colony: Colony, count: number): void {
  const next = Number.isFinite(count) ? clamp(Math.round(count), 1, MAX_ROBOTS) : colony.count;
  for (let index = colony.count; index < next; index++) {
    const robot = colony.robots[index]!;
    const random = mulberry32.create(robotSeed(colony.seed, index));
    colony.randoms[index] = random;
    spawn(colony, index);
    placeRobot(robot, colony.terrain, spot[0], spot[1], mulberry32.sample(random) * Math.PI * 2);
    colony.count = index + 1;
    // Every third dog carries the sensor payload (lidar mast and payload box).
    robot.palette = index % 3 === 1 ? 1 : 0;
    robot.phase = mulberry32.sample(random);
    colony.idle[index] = 0.5 + mulberry32.sample(random) * 2;
  }
  for (let index = next; index < colony.count; index++) colony.robots[index]!.active = false;
  colony.count = next;
  if (colony.destination.active) layoutSlots(colony);
}

export function setPreset(colony: Colony, preset: PresetName): void {
  setCount(colony, PRESETS[preset].count);
}

/** Point every robot at a shared destination (each gets its own slot around it). */
export function setDestination(colony: Colony, x: number, z: number): void {
  colony.destination.active = true;
  colony.destination.x = clampToTile(x, 0.8);
  colony.destination.z = clampToTile(z, 0.8);
  colony.destination.revision++;
  layoutSlots(colony);
}

export function clearDestination(colony: Colony): void {
  if (!colony.destination.active) return;
  colony.destination.active = false;
  colony.destination.revision++;
  // Robots idle a moment where they stand before wandering again.
  for (let index = 0; index < colony.count; index++) colony.idle[index] = 0.6 + (index % 5) * 0.3;
}

/**
 * Advance by real elapsed seconds: runs whole fixed steps (at most MAX_CATCH_UP) and returns how
 * many ran. A paused colony runs none and keeps no backlog. `beforeStep` runs before each fixed
 * step (the renderer sets the brush there, so a timed sculpt counts steps, not frames).
 */
export function advance(colony: Colony, elapsed: number, beforeStep?: (colony: Colony) => void): number {
  if (colony.paused || !(elapsed > 0)) {
    colony.accumulator = 0;
    return 0;
  }
  colony.accumulator += elapsed;
  let steps = Math.floor(colony.accumulator / FIXED_DT + 1e-9);
  if (steps > MAX_CATCH_UP) {
    colony.dropped += steps - MAX_CATCH_UP;
    steps = MAX_CATCH_UP;
    colony.accumulator = 0;
  } else {
    colony.accumulator = Math.max(0, colony.accumulator - steps * FIXED_DT);
  }
  for (let k = 0; k < steps; k++) {
    beforeStep?.(colony);
    step(colony);
  }
  return steps;
}

/** One fixed step, paused or not (the GUI's single step). */
export function step(colony: Colony): void {
  applyBrush(colony);
  resolveCrowding(colony);
  for (let index = 0; index < colony.count; index++) {
    const robot = colony.robots[index]!;
    steer(colony, index);
    stepRobot(robot, {
      terrain: colony.terrain,
      dt: FIXED_DT,
      pace: colony.pace,
      steerX: steering[0],
      steerZ: steering[1],
      pushX: colony.push[index * 2]!,
      pushZ: colony.push[index * 2 + 1]!,
    });
  }
  colony.time += FIXED_DT;
  colony.steps++;
}

function applyBrush(colony: Colony): void {
  const { brush, terrain } = colony;
  if (!brush.active) return;
  const radius = clamp(brush.radius, BRUSH_RADIUS.min, BRUSH_RADIUS.max);
  const strength = clamp(brush.strength, BRUSH_STRENGTH.min, BRUSH_STRENGTH.max);
  const x = clampToTile(brush.x);
  const z = clampToTile(brush.z);
  sculpt(terrain, { x, z, radius, rate: brush.mode === "lower" ? -strength : strength }, FIXED_DT);
}

const steering: [number, number] = [0, 0];
const goal: [number, number] = [0, 0];

/** Share of a pair's push a resting robot takes when the other is walking: the walker yields. */
const RESTING_SHARE = 0.2;

/**
 * Pushes overlapping pairs apart by half their overlap per step, so a crowd closer than MIN_GAP
 * opens up over a few steps. Two walkers (or two resting robots) split the push evenly; a walker
 * pressing into a resting robot takes most of it, so arrivals are not shoved off their slots. The
 * push is only requested here: stepRobot adds it to the body's own move, under the same support
 * guard, so it never drags a planted foot out of reach.
 */
function resolveCrowding(colony: Colony): void {
  const push = colony.push;
  push.fill(0);
  for (let a = 0; a < colony.count; a++) {
    const first = colony.robots[a]!;
    for (let b = a + 1; b < colony.count; b++) {
      const second = colony.robots[b]!;
      const dx = second.position[0] - first.position[0];
      const dz = second.position[2] - first.position[2];
      const distance = Math.hypot(dx, dz);
      if (distance >= MIN_GAP) continue;
      // Coincident centres split along a fixed, index-derived direction.
      const nx = distance > 1e-6 ? dx / distance : Math.cos(a + b);
      const nz = distance > 1e-6 ? dz / distance : Math.sin(a + b);
      const shift = (MIN_GAP - distance) * 0.5;
      const firstShare = first.arrived === second.arrived ? 0.5 : first.arrived ? RESTING_SHARE : 1 - RESTING_SHARE;
      push[a * 2] -= nx * shift * firstShare;
      push[a * 2 + 1] -= nz * shift * firstShare;
      push[b * 2] += nx * shift * (1 - firstShare);
      push[b * 2 + 1] += nz * shift * (1 - firstShare);
    }
  }
}

/** Sunflower ranks tried per layout; enough to fill 48 slots into a quarter disc at a corner. */
const SLOT_RANKS = 720;
/** Slots stay this far inside the rim, clear of the steering's edge push (HALF − 1). */
const SLOT_MARGIN = 1;

/**
 * Lay out one slot per robot around the destination and hand them out. Sunflower points
 * 0.95·√(rank + 0.8) from the destination are clamped onto the tile; a point within SLOT_GAP of an
 * earlier slot (the rim folds outer ranks onto each other) is skipped, so the crowd fans out along the rim instead of stacking there. If the
 * tile cannot fit them all at SLOT_GAP, the gap shrinks until it can. Slots go innermost first to
 * the nearest robot still without one: stable for the whole walk, and short paths that rarely cross.
 */
function layoutSlots(colony: Colony): void {
  const { slots, slotOf, destination } = colony;
  const count = colony.count;
  let filled = 0;
  for (let gap = SLOT_GAP; filled < count; gap *= 0.9) {
    filled = 0;
    for (let rank = 0; rank < SLOT_RANKS && filled < count; rank++) {
      const radius = rank === 0 ? 0 : 0.95 * Math.sqrt(rank + 0.8);
      const angle = rank * GOLDEN_ANGLE;
      spot[0] = clampToTile(destination.x + Math.cos(angle) * radius, SLOT_MARGIN);
      spot[1] = clampToTile(destination.z + Math.sin(angle) * radius, SLOT_MARGIN);
      let clear = true;
      for (let other = 0; other < filled && clear; other++) clear = Math.hypot(slots[other * 2]! - spot[0], slots[other * 2 + 1]! - spot[1]) >= gap;
      if (!clear) continue;
      slots[filled * 2] = spot[0];
      slots[filled * 2 + 1] = spot[1];
      filled++;
    }
  }
  slotOf.fill(-1);
  for (let slot = 0; slot < count; slot++) {
    let nearest = -1;
    let nearestDistance = Infinity;
    for (let index = 0; index < count; index++) {
      if (slotOf[index] !== -1) continue;
      const position = colony.robots[index]!.position;
      const distance = Math.hypot(position[0] - slots[slot * 2]!, position[2] - slots[slot * 2 + 1]!);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearest = index;
      }
    }
    slotOf[nearest] = slot;
  }
  for (let index = 0; index < count; index++) restartProgress(colony, index);
}

const WANDER_TRIES = 6;

/** Room around a candidate goal: the distance to the nearest other robot or its unfinished goal. */
function roomAt(colony: Colony, index: number, x: number, z: number): number {
  let room = Infinity;
  for (let other = 0; other < colony.count; other++) {
    if (other === index) continue;
    const neighbour = colony.robots[other]!;
    room = Math.min(room, Math.hypot(neighbour.position[0] - x, neighbour.position[2] - z));
    if (!neighbour.arrived) room = Math.min(room, Math.hypot(neighbour.goal[0] - x, neighbour.goal[1] - z));
  }
  return room;
}

function pickWander(colony: Colony, index: number): void {
  const robot = colony.robots[index]!;
  const random = colony.randoms[index]!;
  // A short hop from where it stands, biased back toward the middle of the tile; candidates that
  // land within SPACING of another robot (or where one is heading) are rejected, else the roomiest.
  let best = -1;
  let bestX = robot.position[0];
  let bestZ = robot.position[2];
  for (let attempt = 0; attempt < WANDER_TRIES; attempt++) {
    const angle = mulberry32.sample(random) * Math.PI * 2;
    const distance = 1.2 + mulberry32.sample(random) * 2.2;
    const x = robot.position[0] * 0.7 + Math.cos(angle) * distance;
    const z = robot.position[2] * 0.7 + Math.sin(angle) * distance;
    goal[0] = clampToTile(x, 1.1);
    goal[1] = clampToTile(z, 1.1);
    const room = roomAt(colony, index, goal[0], goal[1]);
    if (room > best) {
      best = room;
      bestX = goal[0];
      bestZ = goal[1];
    }
    if (room >= SPACING) break;
  }
  robot.goal[0] = bestX;
  robot.goal[1] = bestZ;
  robot.arrived = false;
  restartProgress(colony, index);
}

/** Seconds without getting closer to its goal after which a robot changes plan (see unblock). */
export const STALL_TIME = 1.5;
/** Getting this much closer to the goal counts as progress. */
const PROGRESS = 0.05;

function restartProgress(colony: Colony, index: number): void {
  colony.progress[index] = Infinity;
  colony.stall[index] = 0;
}

/**
 * A walking robot that has not got closer to its goal for STALL_TIME changes plan instead of
 * pressing on. Wandering, it picks another goal. Walking to a destination it is usually walled out
 * by robots already resting in their slots (slots are SLOT_GAP apart, too narrow to pass between
 * under MIN_GAP), so it swaps slots with a resting neighbour it touches that stands at least half
 * a slot gap nearer its slot than it does: the neighbour steps inward into the hole and the stalled
 * robot takes the place it leaves, the way a crowd shuffles in. Two walkers can also block each other
 * nose to nose, each near the other's slot; with no such resting neighbour it swaps with a touching
 * walker when that cuts the pair's summed distance to their slots by at least half a slot gap. Both
 * are local checks at the moment of the swap, not a global ordering: robots keep moving, so a robot
 * can stall and swap again, at most once per STALL_TIME (colony.swaps counts them). With no such
 * neighbour it keeps walking and checks again after another STALL_TIME.
 */
function unblock(colony: Colony, index: number): void {
  if (!colony.destination.active) {
    pickWander(colony, index);
    return;
  }
  const robot = colony.robots[index]!;
  const slot = colony.slotOf[index]!;
  const slotX = colony.slots[slot * 2]!;
  const slotZ = colony.slots[slot * 2 + 1]!;
  const distance = Math.hypot(slotX - robot.position[0], slotZ - robot.position[2]);
  let best = -1;
  let bestDistance = distance - SLOT_GAP * 0.5;
  let walker = -1;
  let walkerGain = SLOT_GAP * 0.5;
  for (let other = 0; other < colony.count; other++) {
    const neighbour = colony.robots[other]!;
    if (other === index) continue;
    if (Math.hypot(neighbour.position[0] - robot.position[0], neighbour.position[2] - robot.position[2]) > SPACING + 0.15) continue;
    const toHole = Math.hypot(neighbour.position[0] - slotX, neighbour.position[2] - slotZ);
    if (neighbour.arrived) {
      if (toHole < bestDistance) {
        bestDistance = toHole;
        best = other;
      }
      continue;
    }
    const otherSlot = colony.slotOf[other]!;
    const otherX = colony.slots[otherSlot * 2]!;
    const otherZ = colony.slots[otherSlot * 2 + 1]!;
    const before = distance + Math.hypot(otherX - neighbour.position[0], otherZ - neighbour.position[2]);
    const after = toHole + Math.hypot(otherX - robot.position[0], otherZ - robot.position[2]);
    if (before - after >= walkerGain) {
      walkerGain = before - after;
      walker = other;
    }
  }
  restartProgress(colony, index);
  if (best < 0) best = walker;
  if (best < 0) return;
  colony.slotOf[index] = colony.slotOf[best]!;
  colony.slotOf[best] = slot;
  colony.swaps++;
}

/** A robot settles within ARRIVE of its goal, and a resting one walks back past RESUME. */
export const ARRIVE = 0.14;
export const RESUME = 0.25;

function steer(colony: Colony, index: number): void {
  const robot = colony.robots[index]!;
  if (colony.destination.active) {
    const slot = colony.slotOf[index]!;
    goal[0] = colony.slots[slot * 2]!;
    goal[1] = colony.slots[slot * 2 + 1]!;
    if (robot.goal[0] !== goal[0] || robot.goal[1] !== goal[1]) {
      robot.goal[0] = goal[0];
      robot.goal[1] = goal[1];
      robot.arrived = false;
      restartProgress(colony, index);
    } else if (robot.arrived && Math.hypot(goal[0] - robot.position[0], goal[1] - robot.position[2]) > RESUME) {
      // Pushed off its slot: walk back (the gap to ARRIVE keeps a nudge from waking it).
      robot.arrived = false;
      restartProgress(colony, index);
    }
  } else if (robot.arrived) {
    colony.idle[index]! -= FIXED_DT;
    if (colony.idle[index]! <= 0) pickWander(colony, index);
  }
  const x = robot.position[0];
  const z = robot.position[2];
  let sx = 0;
  let sz = 0;
  let toGoal = 0;
  if (!robot.arrived) {
    const dx = robot.goal[0] - x;
    const dz = robot.goal[1] - z;
    const distance = Math.hypot(dx, dz);
    toGoal = distance;
    if (distance < colony.progress[index]! - PROGRESS) {
      colony.progress[index] = distance;
      colony.stall[index] = 0;
    } else {
      colony.stall[index]! += FIXED_DT;
    }
    if (distance < ARRIVE) {
      robot.arrived = true;
      colony.idle[index] = 0.8 + mulberry32.sample(colony.randoms[index]!) * 1.6;
    } else {
      const urgency = clamp(distance / 0.9, 0.25, 1);
      sx = (dx / distance) * urgency;
      sz = (dz / distance) * urgency;
      if (colony.stall[index]! >= STALL_TIME) unblock(colony, index);
    }
  }
  // Separation: only while moving, so a crowd at rest does not shuffle forever. It fades over the
  // last stretch to the goal, where neighbouring slots sit closer than SPACING (resolveCrowding
  // still holds the MIN_GAP floor), so arrivals settle instead of stalling short of their slot.
  const moving = !robot.arrived;
  if (moving) {
    const yieldFactor = clamp(toGoal / 1.2, 0.15, 1);
    for (let other = 0; other < colony.count; other++) {
      if (other === index) continue;
      const neighbour = colony.robots[other]!;
      const dx = x - neighbour.position[0];
      const dz = z - neighbour.position[2];
      const distance = Math.hypot(dx, dz);
      if (distance >= SPACING || distance < 1e-6) continue;
      const push = ((SPACING - distance) / SPACING) * 1.6 * yieldFactor;
      sx += (dx / distance) * push;
      sz += (dz / distance) * push;
    }
    const edge = HALF - 1;
    if (Math.abs(x) > edge) sx -= Math.sign(x) * (Math.abs(x) - edge) * 2;
    if (Math.abs(z) > edge) sz -= Math.sign(z) * (Math.abs(z) - edge) * 2;
  }
  const length = Math.hypot(sx, sz);
  steering[0] = length > 1 ? sx / length : sx;
  steering[1] = length > 1 ? sz / length : sz;
}

export interface ColonyStats {
  robots: number;
  swinging: number;
  /** Mean realised planar ground speed over all robots, world units per second. */
  meanSpeed: number;
  /**
   * Largest FABRIK residual of a planted leg this step, world units: the solved tip against the
   * clamped in-plane goal it was given. Not the world foot-to-ground error (out-of-reach goals are
   * clamped before solving; rejected solves are counted in `rejected`).
   */
  worstResidual: number;
  /** Leg solves that kept the previous pose (non-finite or knee-flipped result) since the last reset. */
  rejected: number;
}

/** Read-only counters for the stats panel. */
export function readStats(colony: Colony, out: ColonyStats): ColonyStats {
  let swinging = 0;
  let speed = 0;
  let worst = 0;
  let rejected = 0;
  for (let index = 0; index < colony.count; index++) {
    const robot = colony.robots[index]!;
    // Realised planar ground speed (smoothed over GROUND_SMOOTHING), not the commanded walk speed:
    // a robot held back by the support guard or a neighbour reads slower than it is trying to walk.
    speed += Math.hypot(robot.velocity[0], robot.velocity[1]);
    for (let leg = 0; leg < robot.legs.length; leg++) {
      const l = robot.legs[leg]!;
      rejected += l.rejected;
      if (robot.feet[leg]!.planted) worst = Math.max(worst, Number.isFinite(l.error) ? l.error : 0);
      else swinging++;
    }
  }
  out.robots = colony.count;
  out.swinging = swinging;
  out.meanSpeed = colony.count > 0 ? speed / colony.count : 0;
  out.worstResidual = worst;
  out.rejected = rejected;
  return out;
}
