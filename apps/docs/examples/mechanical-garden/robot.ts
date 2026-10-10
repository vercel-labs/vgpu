// One robot dog: kinematic locomotion on the terrain. Steering sets a heading and a speed; the body
// is carried along that path, and its height and tilt come from the planted feet. Feet are stored
// in world space: a planted foot keeps its x/z and follows the terrain height, and a swinging foot
// arcs over the sampled terrain to a foothold re-queried every step. A trot lifts one diagonal pair
// (front-right + rear-left, or rear-right + front-left) at a time. Nothing here is physics: the legs
// are posed by IK to meet the feet, and the body heave and tilt follow the support feet.

import { clamp, deltaAngle, mat3, quat, vec3, type Mat3, type Quat, type Vec3 } from "math";
import { spring, type Spring } from "math/time";

import { ABD_LIMIT, createLeg, FEMUR_BACK, FEMUR_FORWARD, HIP_OFFSET, legAngles, REACH_MAX, REACH_MIN, resetLeg, solveLeg, type Leg, type LegSpec } from "./leg";
import { clampToTile, heightAt, type Terrain } from "./terrain";

/** Leg order: front-right, rear-right, front-left, rear-left. Hips sit at the chassis corners. */
export const LEG_SPECS: readonly LegSpec[] = [
  { hip: [0.1, -0.04, 0.3], side: 1 },
  { hip: [0.1, -0.04, -0.3], side: 1 },
  { hip: [-0.1, -0.04, 0.3], side: -1 },
  { hip: [-0.1, -0.04, -0.3], side: -1 },
];
export const LEG_COUNT = LEG_SPECS.length;
/** Trot pairs: {front-right, rear-left} and {rear-right, front-left}. */
export const PAIR: readonly number[] = [0, 1, 1, 0];
/** Same-side and same-end legs; a foot never lifts while one of these swings. */
export const NEIGHBOURS: readonly (readonly number[])[] = [
  [1, 2],
  [0, 3],
  [3, 0],
  [2, 1],
];

/** Body origin height above the ground plane fitted under it. */
export const RIDE_HEIGHT = 0.53;
export const FOOT_RADIUS = 0.03;
/** Rest foothold relative to the leg plane: a little outward, a little forward. */
const REST_SPLAY = 0.012;
const REST_BIAS = 0.01;
export const STRIDE = 0.34;
export const SWING_TIME = 0.24;
export const SWING_LIFT = 0.08;
export const MAX_SPEED = 0.55;
/** Largest body tilt from the foot-plane fit, in radians. */
export const MAX_TILT = 0.38;
const MAX_GRADIENT = Math.tan(MAX_TILT);
/**
 * Robot footprint radius used by steering and destinations: the farthest rest foothold
 * (hypot(0.112 + HIP_OFFSET, 0.31) ≈ 0.36) plus half a stride, which also covers the chassis nose.
 */
export const BODY_RADIUS = 0.53;
/** Footholds stay this far inside the tile edge. */
const FOOT_EDGE = 0.12;
/**
 * Closest the body centre comes to the tile edge: the farthest rest foothold (≈ 0.36) plus
 * FOOT_EDGE and a margin, so the foothold clamp never pulls an outward foot under its own hip.
 */
export const EDGE_MARGIN = 0.7;
/** Planted feet re-step when the terrain under them moved this much since they landed. */
export const TERRAIN_STEP = 0.06;
/**
 * Joint measures that trigger a step (STEP_*), and the guard band body motion may not push a
 * planted foot past (GUARD_*): the step is cut back instead, so the body waits for the gait rather
 * than dragging feet it cannot reach. Ordered STEP < GUARD < joint limit for every measure.
 */
export const STEP_ABD = 0.28;
export const GUARD_ABD = ABD_LIMIT - 0.08;
export const STEP_REACH_MAX = REACH_MAX - 0.07;
export const GUARD_REACH_MAX = REACH_MAX - 0.02;
export const STEP_REACH_MIN = REACH_MIN + 0.07;
export const GUARD_REACH_MIN = REACH_MIN + 0.02;
export const STEP_PITCH_BACK = FEMUR_BACK - 0.35;
export const GUARD_PITCH_BACK = FEMUR_BACK - 0.12;
export const STEP_PITCH_FORWARD = FEMUR_FORWARD - 0.35;
export const GUARD_PITCH_FORWARD = FEMUR_FORWARD - 0.12;
/**
 * Fastest body turn in rad/s. A corner foot ~0.3 ahead of the body centre moves sideways by
 * 0.3·Δψ, about 0.75·Δψ of abduction at rest height; two trot swings re-plant ±STEP_ABD of it.
 */
export const MAX_TURN_RATE = 1.2;
/** Largest turn a landing foot anticipates, in radians, so it lands inside its sector. */
export const PREDICT_TURN = 0.3;
/** Time constant (s) of the realised ground velocity the gait plans with. */
export const GROUND_SMOOTHING = 0.12;

export interface Foot {
  /** World-space foot centre (the tibia tip sits FOOT_RADIUS above the contact point). */
  readonly position: Vec3;
  readonly start: Vec3;
  readonly landing: Vec3;
  /** 0 when planted, else swing progress in (0, 1]. */
  swing: number;
  planted: boolean;
  /** Terrain height under the foot when it landed. */
  contact: number;
  /** Steps since it last landed (for debug colouring). */
  restSteps: number;
}

export interface Robot {
  readonly index: number;
  active: boolean;
  /** Body origin, world space. */
  readonly position: Vec3;
  readonly rotation: Quat;
  readonly heading: Spring<number>;
  readonly speed: Spring<number>;
  /**
   * The body's realised ground velocity in world x/z, smoothed over GROUND_SMOOTHING. It differs
   * from heading × speed when the crowd pushes the robot or the support guard holds it, and the
   * gait plans footholds from it.
   */
  readonly velocity: [number, number];
  readonly height: Spring<number>;
  /** Springed gradient of the fitted foot plane along the body's right and forward axes. */
  readonly slopeRight: Spring<number>;
  readonly slopeForward: Spring<number>;
  /** World x/z gradient of the last ground fit; kept through diagonal (two-foot) support. */
  readonly gradient: [number, number];
  readonly legs: readonly Leg[];
  readonly feet: readonly Foot[];
  /** Body-space foot targets solved this step. */
  readonly targets: readonly Vec3[];
  /** Which trot pair may lift next. */
  turn: number;
  /** Steering goal in world x/z. */
  readonly goal: [number, number];
  /** Whether the robot has arrived at its goal. */
  arrived: boolean;
  /** Per-robot variation from the seed: 1 carries the sensor payload. */
  palette: number;
  phase: number;
  /** Debug counters. */
  steps: number;
  slipped: number;
  /** Steps whose body motion was cut back to keep the planted feet reachable. */
  held: number;
}

export function createRobot(index: number): Robot {
  const legs = LEG_SPECS.map((spec) => createLeg(spec));
  const robot: Robot = {
    index,
    active: false,
    position: [0, 0, 0],
    rotation: [0, 0, 0, 1],
    heading: spring.create(0),
    speed: spring.create(0),
    velocity: [0, 0],
    height: spring.create(0),
    slopeRight: spring.create(0),
    slopeForward: spring.create(0),
    gradient: [0, 0],
    legs,
    feet: legs.map(() => ({ position: [0, 0, 0], start: [0, 0, 0], landing: [0, 0, 0], swing: 0, planted: true, contact: 0, restSteps: 0 })),
    targets: legs.map(() => [0, 0, 0] as Vec3),
    turn: 0,
    goal: [0, 0],
    arrived: true,
    palette: 0,
    phase: 0,
    steps: 0,
    slipped: 0,
    held: 0,
  };
  return robot;
}

function resetSpring(state: Spring<number>, value: number): void {
  state.value = value;
  state.velocity = 0;
}

/** A leg's rest foothold in body space: under its leg plane at ride height, the foot's centre. */
export function restFootLocal(out: Vec3, spec: LegSpec): Vec3 {
  out[0] = spec.hip[0] + spec.side * (HIP_OFFSET + REST_SPLAY);
  out[1] = FOOT_RADIUS - RIDE_HEIGHT;
  out[2] = spec.hip[2] + REST_BIAS;
  return out;
}

const restLocal: Vec3 = [0, 0, 0];
const scratch: Vec3 = [0, 0, 0];

/** Place the robot standing still at (x, z) facing `heading`, feet planted at rest. */
export function placeRobot(robot: Robot, terrain: Terrain, x: number, z: number, heading: number): void {
  robot.active = true;
  resetSpring(robot.heading, heading);
  resetSpring(robot.speed, 0);
  robot.velocity[0] = 0;
  robot.velocity[1] = 0;
  resetSpring(robot.slopeRight, 0);
  resetSpring(robot.slopeForward, 0);
  robot.gradient[0] = 0;
  robot.gradient[1] = 0;
  robot.position[0] = x;
  robot.position[2] = z;
  robot.goal[0] = x;
  robot.goal[1] = z;
  robot.arrived = true;
  robot.turn = 0;
  robot.steps = 0;
  robot.slipped = 0;
  robot.held = 0;
  setRotation(robot, heading, 0, 0);
  // Feet first on the ground under the rest pose, then the body height from them.
  robot.position[1] = heightAt(terrain, x, z) + RIDE_HEIGHT;
  for (let leg = 0; leg < LEG_COUNT; leg++) {
    const foot = robot.feet[leg]!;
    restFootWorld(foot.position, robot, leg);
    foot.position[1] = heightAt(terrain, foot.position[0], foot.position[2]) + FOOT_RADIUS;
    vec3.copy(foot.start, foot.position);
    vec3.copy(foot.landing, foot.position);
    foot.contact = foot.position[1] - FOOT_RADIUS;
    foot.planted = true;
    foot.swing = 0;
    foot.restSteps = 0;
    resetLeg(robot.legs[leg]!);
  }
  resetSpring(robot.height, meanPlanted(robot) + RIDE_HEIGHT);
  robot.position[1] = robot.height.value;
  solveLegs(robot);
}

const bodyFrame: Mat3 = mat3.create();
const axisUp: Vec3 = [0, 0, 0];
const axisForward: Vec3 = [0, 0, 0];
const axisRight: Vec3 = [0, 0, 0];

/**
 * Body rotation from a heading and the gradient of the ground plane y = gr·right + gf·forward:
 * up is the plane normal, forward is the heading direction carried onto the plane.
 */
export function setRotation(robot: Robot, heading: number, gradientRight: number, gradientForward: number): void {
  const c = Math.cos(heading);
  const s = Math.sin(heading);
  // Heading frame: right = (cos h, 0, −sin h), forward = (sin h, 0, cos h).
  vec3.set(axisUp, -gradientRight * c - gradientForward * s, 1, gradientRight * s - gradientForward * c);
  vec3.normalize(axisUp, axisUp);
  vec3.set(axisForward, s, gradientForward, c);
  vec3.normalize(axisForward, axisForward);
  vec3.cross(axisRight, axisUp, axisForward);
  vec3.normalize(axisRight, axisRight);
  bodyFrame[0] = axisRight[0];
  bodyFrame[1] = axisRight[1];
  bodyFrame[2] = axisRight[2];
  bodyFrame[3] = axisUp[0];
  bodyFrame[4] = axisUp[1];
  bodyFrame[5] = axisUp[2];
  bodyFrame[6] = axisForward[0];
  bodyFrame[7] = axisForward[1];
  bodyFrame[8] = axisForward[2];
  quat.normalize(robot.rotation, quat.fromMat3(robot.rotation, bodyFrame));
}

/**
 * World position of a leg's rest foothold under a body pose: the current rotation turned by `yaw`
 * about world +Y, at (x, z). Tilt is included, so on a slope the rest feet sit under the hips along
 * the body's own down axis. y is left at the body height (callers sample the terrain).
 */
function poseFoothold(out: Vec3, robot: Robot, leg: number, yaw: number, x: number, z: number): Vec3 {
  restFootLocal(restLocal, LEG_SPECS[leg]!);
  vec3.transformQuat(scratch, restLocal, robot.rotation);
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  out[0] = x + c * scratch[0] + s * scratch[2];
  out[1] = robot.position[1];
  out[2] = z - s * scratch[0] + c * scratch[2];
  return out;
}

/** World position of a leg's rest foothold under the current body pose (y left at body height). */
export function restFootWorld(out: Vec3, robot: Robot, leg: number): Vec3 {
  return poseFoothold(out, robot, leg, 0, robot.position[0], robot.position[2]);
}

function meanPlanted(robot: Robot): number {
  let sum = 0;
  let count = 0;
  for (const foot of robot.feet) {
    if (!foot.planted) continue;
    sum += foot.position[1] - FOOT_RADIUS;
    count++;
  }
  return count > 0 ? sum / count : robot.position[1] - RIDE_HEIGHT;
}

const inverse: Quat = [0, 0, 0, 1];

/** World point → body space under the current pose. */
export function toBody(out: Vec3, robot: Robot, world: Vec3): Vec3 {
  vec3.subtract(out, world, robot.position);
  quat.invert(inverse, robot.rotation);
  return vec3.transformQuat(out, out, inverse);
}

function solveLegs(robot: Robot): void {
  for (let leg = 0; leg < LEG_COUNT; leg++) {
    const target = robot.targets[leg]!;
    toBody(target, robot, robot.feet[leg]!.position);
    solveLeg(robot.legs[leg]!, target);
  }
}

export interface StepContext {
  readonly terrain: Terrain;
  readonly dt: number;
  /** Desired speed scale in [0, 1] (reduced motion lowers it). */
  readonly pace: number;
  /** Steering acceleration toward the goal plus separation, x/z. */
  readonly steerX: number;
  readonly steerZ: number;
  /** Body displacement the crowd asks for this step, x/z (see colony resolveCrowding). */
  readonly pushX?: number;
  readonly pushZ?: number;
}

const local: Vec3 = [0, 0, 0];

/** Advance one fixed step. */
export function stepRobot(robot: Robot, context: StepContext): void {
  const { terrain, dt } = context;
  robot.steps++;
  // --- Steering: heading and speed springs on the fixed step, the turn rate capped.
  const steer = Math.hypot(context.steerX, context.steerZ);
  const wanted = steer > 1e-4 ? Math.atan2(context.steerX, context.steerZ) : robot.heading.value;
  const heading0 = robot.heading.value;
  spring.dampAngle(robot.heading, wanted, 0.45, dt);
  const maxTurn = MAX_TURN_RATE * dt;
  const turn = clamp(deltaAngle(heading0, robot.heading.value), -maxTurn, maxTurn);
  robot.heading.velocity = clamp(robot.heading.velocity, -MAX_TURN_RATE, MAX_TURN_RATE);
  const misalign = Math.abs(deltaAngle(heading0 + turn, wanted));
  const desiredSpeed = MAX_SPEED * context.pace * clamp(steer, 0, 1) * Math.max(0, Math.cos(Math.min(misalign, Math.PI / 2)));
  spring.damp(robot.speed, desiredSpeed, 0.35, dt);
  const speed = Math.max(0, robot.speed.value);
  // The walk, the crowd's push and the tile clamp form one move, and the body makes only as much of
  // it as its planted feet can follow (see supportFraction).
  const walkX = robot.position[0] + Math.sin(heading0 + turn) * speed * dt + (context.pushX ?? 0);
  const walkZ = robot.position[2] + Math.cos(heading0 + turn) * speed * dt + (context.pushZ ?? 0);
  const moveX = clampToTile(walkX, EDGE_MARGIN) - robot.position[0];
  const moveZ = clampToTile(walkZ, EDGE_MARGIN) - robot.position[2];
  const fraction = supportFraction(robot, turn, moveX, moveZ);
  if (fraction < 1) {
    robot.held++;
    robot.heading.velocity *= fraction;
  }
  robot.heading.value = heading0 + turn * fraction;
  robot.position[0] += moveX * fraction;
  robot.position[2] += moveZ * fraction;
  // Carry the body's rotation through the accepted yaw, tilt kept, until fitBody refits it.
  setRotation(robot, robot.heading.value, robot.slopeRight.value, robot.slopeForward.value);
  const smoothing = 1 - Math.exp(-dt / GROUND_SMOOTHING);
  robot.velocity[0] += ((moveX * fraction) / dt - robot.velocity[0]) * smoothing;
  robot.velocity[1] += ((moveZ * fraction) / dt - robot.velocity[1]) * smoothing;

  // --- Feet: planted feet follow the terrain; swinging feet arc toward a fresh foothold. The gait
  // runs on the realised ground speed: a robot walking into a neighbour that pushes back must not
  // plant its feet a stride ahead of a body that stays put.
  const yawRate = robot.heading.velocity;
  const ground = Math.hypot(robot.velocity[0], robot.velocity[1]);
  const stance = STRIDE / Math.max(ground, 0.05);
  const lead = clamp(SWING_TIME + 0.5 * Math.min(stance, 1.2), 0, 0.7);
  for (let leg = 0; leg < LEG_COUNT; leg++) {
    const foot = robot.feet[leg]!;
    if (foot.planted) {
      foot.restSteps++;
      foot.position[1] = heightAt(terrain, foot.position[0], foot.position[2]) + FOOT_RADIUS;
      continue;
    }
    predictFoothold(foot.landing, robot, leg, yawRate, lead * (1 - foot.swing), terrain);
    foot.swing = Math.min(1, foot.swing + dt / SWING_TIME);
    swingPosition(foot, terrain);
    if (foot.swing >= 1) {
      foot.planted = true;
      foot.swing = 0;
      foot.restSteps = 0;
      vec3.copy(foot.position, foot.landing);
      foot.contact = foot.position[1] - FOOT_RADIUS;
    }
  }

  // --- Gait: lift the pair whose turn it is when its feet stray, never next to a swinging foot.
  let swinging = 0;
  for (const foot of robot.feet) if (!foot.planted) swinging++;
  if (swinging === 0) {
    let need = needsStep(robot, robot.turn, terrain, ground);
    if (need === 0) {
      const other = 1 - robot.turn;
      if (needsStep(robot, other, terrain, ground) > 0) {
        robot.turn = other;
        need = 1;
      }
    }
    if (need > 0) {
      for (let leg = 0; leg < LEG_COUNT; leg++) {
        if (PAIR[leg] !== robot.turn) continue;
        const foot = robot.feet[leg]!;
        if (!legWantsStep(robot, leg, terrain, ground, 0.03)) continue;
        if (NEIGHBOURS[leg]!.some((n) => !robot.feet[n]!.planted)) continue;
        foot.planted = false;
        foot.swing = 0;
        vec3.copy(foot.start, foot.position);
        predictFoothold(foot.landing, robot, leg, yawRate, lead, terrain);
      }
      robot.turn = 1 - robot.turn;
    }
  }

  // --- Body pose from the planted feet.
  fitBody(robot, dt, swinging);

  solveLegs(robot);
  for (let leg = 0; leg < LEG_COUNT; leg++) {
    if (robot.feet[leg]!.planted && robot.legs[leg]!.error > 0.01) robot.slipped++;
  }
}

/** Whether any foot of a trot pair needs a step (1) or not (0). */
function needsStep(robot: Robot, pair: number, terrain: Terrain, speed: number): number {
  for (let leg = 0; leg < LEG_COUNT; leg++) {
    if (PAIR[leg] === pair && legWantsStep(robot, leg, terrain, speed, 0)) return 1;
  }
  return 0;
}

/**
 * A planted foot wants a step when it strayed more than half a stride from its rest foothold,
 * when its joints left the comfortable band, or when the terrain under it moved since it landed.
 * `slack` > 0 asks only "is it measurably out of place" (used to pick which feet of a pair lift).
 */
export function legWantsStep(robot: Robot, leg: number, terrain: Terrain, speed: number, slack: number): boolean {
  const foot = robot.feet[leg]!;
  if (!foot.planted) return false;
  restFootWorld(scratch, robot, leg);
  const drift = Math.hypot(foot.position[0] - scratch[0], foot.position[2] - scratch[2]);
  if (slack > 0) return drift > slack || reachOut(robot, leg) || terrainMoved(foot, terrain);
  const strideLimit = speed > 0.02 ? STRIDE * 0.5 : STRIDE * 0.3;
  return drift > strideLimit || reachOut(robot, leg) || terrainMoved(foot, terrain);
}

/** Whether a planted foot left the comfortable abduction, pitch or reach band of its leg. */
function reachOut(robot: Robot, leg: number): boolean {
  toBody(local, robot, robot.feet[leg]!.position);
  const a = legAngles(LEG_SPECS[leg]!, local);
  return (
    Math.abs(a.abduction) > STEP_ABD ||
    a.reach > STEP_REACH_MAX ||
    a.reach < STEP_REACH_MIN ||
    a.pitch > STEP_PITCH_BACK ||
    a.pitch < -STEP_PITCH_FORWARD
  );
}

const strainBefore: number[] = LEG_SPECS.map(() => 0);
const SUPPORT_FRACTIONS = [1, 0.5, 0.25];
const candidate: Quat = [0, 0, 0, 1];
const candidateInverse: Quat = [0, 0, 0, 1];
const yawTurn: Quat = [0, 0, 0, 1];
const WORLD_UP: Vec3 = [0, 1, 0];

/**
 * How much of this step's turn and move the body may take: the largest of 1, ½ or ¼ that pushes
 * no planted foot further past the guard band, else 0. Candidate poses are the current rotation
 * turned about world +Y, with the full body tilt, carried through the same body transform the legs
 * are solved in. A foot already past the guard (sculpted terrain, a late landing) only blocks
 * motion that makes it worse; the gait steps it because every STEP_* sits inside its GUARD_*.
 */
function supportFraction(robot: Robot, turn: number, moveX: number, moveZ: number): number {
  const x0 = robot.position[0];
  const z0 = robot.position[2];
  quat.invert(candidateInverse, robot.rotation);
  for (let leg = 0; leg < LEG_COUNT; leg++) strainBefore[leg] = strain(robot, leg, x0, z0);
  for (const fraction of SUPPORT_FRACTIONS) {
    // The move ends inside the tile (stepRobot clamps it), so every fraction of it does too.
    quat.setAxisAngle(yawTurn, WORLD_UP, turn * fraction);
    quat.multiply(candidate, yawTurn, robot.rotation);
    quat.invert(candidateInverse, candidate);
    const x = x0 + moveX * fraction;
    const z = z0 + moveZ * fraction;
    let ok = true;
    for (let leg = 0; leg < LEG_COUNT && ok; leg++) {
      const after = strain(robot, leg, x, z);
      ok = after <= 0 || after <= strainBefore[leg]! + 1e-9;
    }
    if (ok) return fraction;
  }
  return 0;
}

/**
 * How far a planted foot sits outside the guarded abduction, pitch and reach bands for a body at
 * (x, current height, z) with the rotation whose inverse is in `candidateInverse`.
 */
function strain(robot: Robot, leg: number, x: number, z: number): number {
  const foot = robot.feet[leg]!;
  if (!foot.planted) return 0;
  local[0] = foot.position[0] - x;
  local[1] = foot.position[1] - robot.position[1];
  local[2] = foot.position[2] - z;
  vec3.transformQuat(local, local, candidateInverse);
  const a = legAngles(LEG_SPECS[leg]!, local);
  return (
    Math.max(0, Math.abs(a.abduction) - GUARD_ABD) +
    Math.max(0, a.reach - GUARD_REACH_MAX) +
    Math.max(0, GUARD_REACH_MIN - a.reach) +
    Math.max(0, a.pitch - GUARD_PITCH_BACK) +
    Math.max(0, -GUARD_PITCH_FORWARD - a.pitch)
  );
}

function terrainMoved(foot: Foot, terrain: Terrain): boolean {
  return Math.abs(heightAt(terrain, foot.position[0], foot.position[2]) - foot.contact) > TERRAIN_STEP;
}

/** Where a foot should land: the rest foothold under the body pose `lead` seconds ahead. */
function predictFoothold(out: Vec3, robot: Robot, leg: number, yawRate: number, lead: number, terrain: Terrain): Vec3 {
  const yaw = clamp(yawRate * lead, -PREDICT_TURN, PREDICT_TURN);
  poseFoothold(out, robot, leg, yaw, robot.position[0] + robot.velocity[0] * lead, robot.position[2] + robot.velocity[1] * lead);
  out[0] = clampToTile(out[0], FOOT_EDGE);
  out[2] = clampToTile(out[2], FOOT_EDGE);
  out[1] = heightAt(terrain, out[0], out[2]) + FOOT_RADIUS;
  return out;
}

const SWING_SAMPLES = 6;

/** Swing arc: eased x/z, linear y plus a clearance bump that clears every sampled bump on the path. */
function swingPosition(foot: Foot, terrain: Terrain): void {
  const t = foot.swing;
  const e = t * t * (3 - 2 * t);
  const { start, landing, position } = foot;
  let clearance = 0;
  for (let k = 1; k < SWING_SAMPLES; k++) {
    const s = k / SWING_SAMPLES;
    const x = start[0] + (landing[0] - start[0]) * s;
    const z = start[2] + (landing[2] - start[2]) * s;
    const line = start[1] + (landing[1] - start[1]) * s;
    clearance = Math.max(clearance, heightAt(terrain, x, z) + FOOT_RADIUS - line);
  }
  position[0] = start[0] + (landing[0] - start[0]) * e;
  position[2] = start[2] + (landing[2] - start[2]) * e;
  const bump = 4 * t * (1 - t) * (SWING_LIFT + clearance);
  position[1] = start[1] + (landing[1] - start[1]) * t + bump;
  // Never dip under the surface right below the foot either.
  position[1] = t >= 1 ? landing[1] : Math.max(position[1], heightAt(terrain, position[0], position[2]) + FOOT_RADIUS);
}

/**
 * Body height and tilt from the planted feet, then springs. The ground is fitted as
 * y = base + gx·dx + gz·dz around the body: least squares with three or more feet; with only a
 * diagonal pair down (every trot swing) the kept gradient is corrected along the diagonal alone, so
 * the tilt across it persists instead of levelling out once per step.
 */
function fitBody(robot: Robot, dt: number, swinging: number): void {
  let n = 0;
  let sx = 0;
  let sz = 0;
  let sy = 0;
  let sxx = 0;
  let szz = 0;
  let sxz = 0;
  let sxy = 0;
  let szy = 0;
  let firstX = 0;
  let firstZ = 0;
  let firstY = 0;
  let lastX = 0;
  let lastZ = 0;
  let lastY = 0;
  for (const foot of robot.feet) {
    if (!foot.planted) continue;
    const dx = foot.position[0] - robot.position[0];
    const dz = foot.position[2] - robot.position[2];
    const y = foot.position[1] - FOOT_RADIUS;
    if (n === 0) {
      firstX = dx;
      firstZ = dz;
      firstY = y;
    }
    lastX = dx;
    lastZ = dz;
    lastY = y;
    n++;
    sx += dx;
    sz += dz;
    sy += y;
    sxx += dx * dx;
    szz += dz * dz;
    sxz += dx * dz;
    sxy += dx * y;
    szy += dz * y;
  }
  const g = robot.gradient;
  let base = robot.height.value - RIDE_HEIGHT;
  if (n >= 3) {
    // Solve the 3×3 normal equations for y = a + gx·dx + gz·dz.
    const mx = sx / n;
    const mz = sz / n;
    const my = sy / n;
    const cxx = sxx / n - mx * mx;
    const czz = szz / n - mz * mz;
    const cxz = sxz / n - mx * mz;
    const cxy = sxy / n - mx * my;
    const czy = szy / n - mz * my;
    const det = cxx * czz - cxz * cxz;
    if (Math.abs(det) > 1e-8) {
      g[0] = (cxy * czz - czy * cxz) / det;
      g[1] = (czy * cxx - cxy * cxz) / det;
    }
    base = my - g[0] * mx - g[1] * mz;
  } else if (n === 2) {
    const ux = lastX - firstX;
    const uz = lastZ - firstZ;
    const span = Math.hypot(ux, uz);
    if (span > 1e-6) {
      const along = (lastY - firstY) / span;
      const correction = along - (g[0] * ux + g[1] * uz) / span;
      g[0] += (correction * ux) / span;
      g[1] += (correction * uz) / span;
    }
    base = sy / 2 - g[0] * (sx / 2) - g[1] * (sz / 2);
  }
  // Clamp the tilt (the gradient's length), keeping its direction.
  const gradient = Math.hypot(g[0], g[1]);
  if (gradient > MAX_GRADIENT) {
    g[0] *= MAX_GRADIENT / gradient;
    g[1] *= MAX_GRADIENT / gradient;
  }
  // Heading frame: right = (cos h, 0, −sin h), forward = (sin h, 0, cos h).
  const c = Math.cos(robot.heading.value);
  const s = Math.sin(robot.heading.value);
  spring.update(robot.slopeRight, g[0] * c - g[1] * s, 0.16, 1, dt);
  spring.update(robot.slopeForward, g[0] * s + g[1] * c, 0.16, 1, dt);
  // Heave: the body dips a little while a pair is airborne.
  spring.update(robot.height, base + RIDE_HEIGHT - (swinging > 0 ? 0.008 : 0), 0.1, 0.9, dt);
  robot.position[1] = robot.height.value;
  setRotation(robot, robot.heading.value, robot.slopeRight.value, robot.slopeForward.value);
}
