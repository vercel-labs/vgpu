// One robot-dog leg in body-local space (+X right, +Y up, +Z forward): an analytic hip abduction
// roll φ about the body's forward axis, then femur + tibia as a two-bone math/ik fabrik3 chain
// hinged about the rolled axis X' = (cos φ, sin φ, 0). The leg plane holds the body's forward axis
// for every φ, so the knee always bends fore-aft and points backward, like the reference robot.
// The app clamps every target into the reachable band itself, because fabrik3's isReachable only
// checks the outer radius, and it checks the knee side after each solve. Segment frames are built
// from the hinge axis (X = hinge, Y = bone, Z = X × Y), so every child joint is a pure rotation
// about its local X.

import { clamp, deltaAngle, mat3, quat, vec3, type Mat3, type Quat, type Vec3 } from "math";
import { fabrik3 } from "math/ik";

export const FEMUR = 0.3;
export const TIBIA = 0.31;
/** Lateral distance from the abduction pivot to the leg plane. */
export const HIP_OFFSET = 0.075;
/** Femur-to-foot distance at a knee interior angle (law of cosines). */
export function reachAt(kneeAngle: number): number {
  return Math.sqrt(FEMUR * FEMUR + TIBIA * TIBIA - 2 * FEMUR * TIBIA * Math.cos(kneeAngle));
}
/** The knee may fold to 35° and open to 160°: the reach band the app asks for. */
export const REACH_MIN = reachAt((35 * Math.PI) / 180);
export const REACH_MAX = reachAt((160 * Math.PI) / 180);
/** How far the hip may roll the leg outward or inward. */
export const ABD_LIMIT = 0.55;
/** Femur pitch limits, measured about X' from the plane's down axis: backward (+) and forward. */
export const FEMUR_BACK = (115 * Math.PI) / 180;
export const FEMUR_FORWARD = (45 * Math.PI) / 180;
/** fabrik3 stops at 0.01 by default; legs need it two orders of magnitude tighter. */
export const SOLVE_THRESHOLD = 1e-4 * (FEMUR + TIBIA);

/** Tibia limits about the same axis and reference: forward (clockwise) and backward. */
const TIBIA_FORWARD = (120 * Math.PI) / 180;
const TIBIA_BACK = (50 * Math.PI) / 180;
/** Deterministic bent rest pose in leg-plane coordinates (s forward, y along up'). */
const REST_PITCH = (50 * Math.PI) / 180;
const REST_KNEE: readonly [number, number] = [-FEMUR * Math.sin(REST_PITCH), -FEMUR * Math.cos(REST_PITCH)];
const FORWARD: Vec3 = [0, 0, 1];

export interface LegSpec {
  /** Abduction pivot in body space. */
  readonly hip: Vec3;
  /** +1 for a right leg, −1 for a left leg: the leg plane sits at hip + side·HIP_OFFSET·X'. */
  readonly side: 1 | -1;
}

export interface Leg {
  readonly spec: LegSpec;
  readonly chain: ReturnType<typeof fabrik3.createChain3>;
  /** Current abduction roll about body +Z. */
  abduction: number;
  /** Hinge axis X', the leg plane's up' and down axes. */
  readonly axis: Vec3;
  readonly up: Vec3;
  readonly down: Vec3;
  /** Femur base (on the leg plane), knee and foot (effector), body space. */
  readonly femurBase: Vec3;
  readonly knee: Vec3;
  readonly foot: Vec3;
  /** The clamped, in-plane target the chain was asked to reach. */
  readonly goal: Vec3;
  /** Distance from the effector to `goal` after the last accepted solve. */
  error: number;
  /** Solves rejected (non-finite input or result) since the last reset. */
  rejected: number;
  /** Solves that came out on the wrong knee side and were re-laid from the rest pose. */
  relaid: number;
  /** Knee and foot in leg-plane coordinates (s, y), used to warm-start the next solve. */
  readonly plane: [number, number, number, number];
}

export function createLeg(spec: LegSpec): Leg {
  const chain = fabrik3.createChain3();
  chain.solveDistanceThreshold = SOLVE_THRESHOLD;
  chain.minIterationChange = SOLVE_THRESHOLD * 1e-2;
  chain.maxIterations = 80;
  // Laid with a bend; resetLeg() re-lays the real pose before any solve.
  fabrik3.addBone(chain, [0, 0, 0], [0, -FEMUR * 0.6, -FEMUR * 0.8], fabrik3.createJoint3());
  fabrik3.addBone(chain, [0, -FEMUR * 0.6, -FEMUR * 0.8], [0, -FEMUR * 0.6 - TIBIA * 0.8, -FEMUR * 0.8 + TIBIA * 0.6], fabrik3.createJoint3());
  const leg: Leg = {
    spec,
    chain,
    abduction: 0,
    axis: [1, 0, 0],
    up: [0, 1, 0],
    down: [0, -1, 0],
    femurBase: [0, 0, 0],
    knee: [0, 0, 0],
    foot: [0, 0, 0],
    goal: [0, 0, 0],
    error: 0,
    rejected: 0,
    relaid: 0,
    plane: [0, 0, 0, 0],
  };
  resetLeg(leg);
  return leg;
}

/**
 * The abduction that puts a body-space point in the leg plane: φ = atan2(py, px) + acos(σd/r)
 * with p measured from the hip, clamped to ±ABD_LIMIT. Inside the offset circle (r ≤ d) the plane
 * is undefined and `fallback` is kept.
 */
export function abductionFor(spec: LegSpec, point: Vec3, fallback: number): number {
  const px = point[0] - spec.hip[0];
  const py = point[1] - spec.hip[1];
  const r = Math.hypot(px, py);
  if (!(r > HIP_OFFSET + 1e-6)) return fallback;
  const wanted = Math.atan2(py, px) + Math.acos(clamp((spec.side * HIP_OFFSET) / r, -1, 1));
  return clamp(deltaAngle(0, wanted), -ABD_LIMIT, ABD_LIMIT);
}

export interface LegAngles {
  /** Abduction roll the point asks for, before the joint clamp. */
  abduction: number;
  /** Femur pitch about X' from down (backward positive) of the two-bone pose with the knee behind. */
  pitch: number;
  /** Femur-base-to-point distance in the leg plane. */
  reach: number;
}

const angles: LegAngles = { abduction: 0, pitch: 0, reach: 0 };

/**
 * Joint angles a body-space point asks of a leg, by the same frame the solver uses (two-bone law
 * of cosines for the pitch). Returns a shared object, overwritten by the next call.
 */
export function legAngles(spec: LegSpec, point: Vec3): LegAngles {
  const px = point[0] - spec.hip[0];
  const py = point[1] - spec.hip[1];
  const r = Math.hypot(px, py);
  const phi = r > HIP_OFFSET + 1e-6 ? deltaAngle(0, Math.atan2(py, px) + Math.acos(clamp((spec.side * HIP_OFFSET) / r, -1, 1))) : 0;
  const clamped = clamp(phi, -ABD_LIMIT, ABD_LIMIT);
  const c = Math.cos(clamped);
  const sn = Math.sin(clamped);
  // Plane coordinates from the femur base: s along +Z, y along up' = (−sin φ, cos φ, 0).
  const bx = px - spec.side * HIP_OFFSET * c;
  const by = py - spec.side * HIP_OFFSET * sn;
  const s = point[2] - spec.hip[2];
  const y = -sn * bx + c * by;
  const reach = Math.hypot(s, y);
  const d = clamp(reach, REACH_MIN, REACH_MAX);
  const along = Math.acos(clamp((FEMUR * FEMUR + d * d - TIBIA * TIBIA) / (2 * FEMUR * d), -1, 1));
  angles.abduction = phi;
  angles.pitch = Math.atan2(-s, -y) + along;
  angles.reach = reach;
  return angles;
}

/** Back to the deterministic bent rest pose; forgets every previous solve. */
export function resetLeg(leg: Leg): void {
  leg.abduction = 0;
  leg.plane[0] = REST_KNEE[0];
  leg.plane[1] = REST_KNEE[1];
  leg.plane[2] = 0;
  leg.plane[3] = -reachAt((82 * Math.PI) / 180);
  leg.error = 0;
  leg.rejected = 0;
  leg.relaid = 0;
  setFrame(leg);
  layFromPlane(leg);
  readChain(leg);
  vec3.copy(leg.goal, leg.foot);
}

function setFrame(leg: Leg): void {
  const { axis, up, down, femurBase, spec } = leg;
  const c = Math.cos(leg.abduction);
  const s = Math.sin(leg.abduction);
  vec3.set(axis, c, s, 0);
  vec3.set(up, -s, c, 0);
  vec3.set(down, s, -c, 0);
  femurBase[0] = spec.hip[0] + spec.side * HIP_OFFSET * c;
  femurBase[1] = spec.hip[1] + spec.side * HIP_OFFSET * s;
  femurBase[2] = spec.hip[2];
}

/** Plane coordinates (s along +Z, y along up') from the femur base into body space. */
function planePoint(out: Vec3, leg: Leg, s: number, y: number): Vec3 {
  out[0] = leg.femurBase[0] + leg.up[0] * y;
  out[1] = leg.femurBase[1] + leg.up[1] * y;
  out[2] = leg.femurBase[2] + s;
  return out;
}

const laidKnee: Vec3 = [0, 0, 0];
const laidFoot: Vec3 = [0, 0, 0];

function layFromPlane(leg: Leg): void {
  const [femur, tibia] = leg.chain.bones as [fabrik3.Bone3, fabrik3.Bone3];
  planePoint(laidKnee, leg, leg.plane[0], leg.plane[1]);
  planePoint(laidFoot, leg, leg.plane[2], leg.plane[3]);
  // Keep the bone lengths exact: re-lay the knee and foot at their rest distances.
  const ks = Math.hypot(leg.plane[0], leg.plane[1]) || 1;
  vec3.copy(femur.start, leg.femurBase);
  planePoint(femur.end, leg, (leg.plane[0] / ks) * FEMUR, (leg.plane[1] / ks) * FEMUR);
  vec3.copy(tibia.start, femur.end);
  vec3.subtract(laidFoot, laidFoot, laidKnee);
  const fl = vec3.length(laidFoot) || 1;
  vec3.scaleAndAdd(tibia.end, tibia.start, laidFoot, TIBIA / fl);
  fabrik3.setBaseLocation(leg.chain, leg.femurBase);
  // Anticlockwise about X' turns the plane's down axis backward (−Z).
  fabrik3.setBaseboneHingeConstraint(leg.chain, fabrik3.BaseboneConstraintType.GLOBAL_HINGE, leg.axis, FEMUR_FORWARD, FEMUR_BACK, leg.down);
  fabrik3.setHingeJoint(tibia.joint, fabrik3.JointType.GLOBAL_HINGE, leg.axis, TIBIA_FORWARD, TIBIA_BACK, leg.down);
}

const reach: Vec3 = [0, 0, 0];
const crossKnee: Vec3 = [0, 0, 0];
const femurDir: Vec3 = [0, 0, 0];
const tibiaDir: Vec3 = [0, 0, 0];

/**
 * Clamp a body-space target into the leg plane and the reachable band. Returns the goal the chain
 * will be asked for (written to `out`), using the leg's current frame.
 */
export function clampGoal(out: Vec3, leg: Leg, target: Vec3): Vec3 {
  vec3.subtract(reach, target, leg.femurBase);
  let s = vec3.dot(reach, FORWARD);
  let y = vec3.dot(reach, leg.up);
  const d = Math.hypot(s, y);
  if (d < 1e-9) {
    s = 0;
    y = -REACH_MIN;
  } else if (d > REACH_MAX) {
    s *= REACH_MAX / d;
    y *= REACH_MAX / d;
  } else if (d < REACH_MIN) {
    s *= REACH_MIN / d;
    y *= REACH_MIN / d;
  }
  return planePoint(out, leg, s, y);
}

/** Which side of the femur→foot line the knee is on: negative = knee behind (the only accepted pose). */
export function kneeSide(leg: Leg): number {
  vec3.subtract(femurDir, leg.knee, leg.femurBase);
  vec3.subtract(tibiaDir, leg.foot, leg.knee);
  vec3.cross(crossKnee, femurDir, tibiaDir);
  return vec3.dot(crossKnee, leg.axis);
}

// The last accepted pose, restored as a whole when a solve is rejected: abduction (and so the
// frame), knee, foot, goal and the warm-start plane coordinates.
const prevKnee: Vec3 = [0, 0, 0];
const prevFoot: Vec3 = [0, 0, 0];
const prevGoal: Vec3 = [0, 0, 0];
const prevPlane: [number, number, number, number] = [0, 0, 0, 0];

/**
 * Point the leg at a body-space foot target. Returns the remaining effector error, or Infinity
 * when the input was rejected (the previous pose is kept).
 */
export function solveLeg(leg: Leg, target: Vec3): number {
  if (!vec3.finite(target)) {
    leg.rejected++;
    return Infinity;
  }
  const prevAbduction = leg.abduction;
  vec3.copy(prevKnee, leg.knee);
  vec3.copy(prevFoot, leg.foot);
  vec3.copy(prevGoal, leg.goal);
  for (let k = 0; k < 4; k++) prevPlane[k] = leg.plane[k]!;
  leg.abduction = abductionFor(leg.spec, target, leg.abduction);
  setFrame(leg);
  clampGoal(leg.goal, leg, target);
  layFromPlane(leg);
  let error = fabrik3.solve(leg.chain, leg.goal);
  readChain(leg);
  if (Number.isFinite(error) && kneeSide(leg) >= 0) {
    // Wrong knee side (or a straightened chain): start over from the bent rest pose.
    leg.relaid++;
    leg.plane[0] = REST_KNEE[0];
    leg.plane[1] = REST_KNEE[1];
    vec3.subtract(reach, leg.goal, leg.femurBase);
    leg.plane[2] = vec3.dot(reach, FORWARD);
    leg.plane[3] = vec3.dot(reach, leg.up);
    layFromPlane(leg);
    error = fabrik3.solve(leg.chain, leg.goal);
    readChain(leg);
  }
  if (!Number.isFinite(error) || !vec3.finite(leg.knee) || !vec3.finite(leg.foot) || kneeSide(leg) >= 0) {
    leg.abduction = prevAbduction;
    setFrame(leg);
    vec3.copy(leg.knee, prevKnee);
    vec3.copy(leg.foot, prevFoot);
    vec3.copy(leg.goal, prevGoal);
    for (let k = 0; k < 4; k++) leg.plane[k] = prevPlane[k]!;
    leg.rejected++;
    return Infinity;
  }
  leg.error = error;
  // Remember the pose in plane coordinates; forward stays in the plane for every abduction.
  vec3.subtract(reach, leg.knee, leg.femurBase);
  leg.plane[0] = vec3.dot(reach, FORWARD);
  leg.plane[1] = vec3.dot(reach, leg.up);
  vec3.subtract(reach, leg.foot, leg.femurBase);
  leg.plane[2] = vec3.dot(reach, FORWARD);
  leg.plane[3] = vec3.dot(reach, leg.up);
  return error;
}

function readChain(leg: Leg): void {
  vec3.copy(leg.knee, leg.chain.bones[0]!.end);
  fabrik3.getEffector(leg.foot, leg.chain);
}

const frame3: Mat3 = mat3.create();
const segment: Vec3 = [0, 0, 0];
const zAxis: Vec3 = [0, 0, 0];

/** Rotation whose columns are (axis, bone direction, axis × bone): +Y of the mesh along the bone. */
export function segmentRotation(out: Quat, axis: Vec3, from: Vec3, to: Vec3): Quat {
  vec3.subtract(segment, to, from);
  vec3.normalize(segment, segment);
  vec3.cross(zAxis, axis, segment);
  vec3.normalize(zAxis, zAxis);
  frame3[0] = axis[0];
  frame3[1] = axis[1];
  frame3[2] = axis[2];
  frame3[3] = segment[0];
  frame3[4] = segment[1];
  frame3[5] = segment[2];
  frame3[6] = zAxis[0];
  frame3[7] = zAxis[1];
  frame3[8] = zAxis[2];
  return quat.normalize(out, quat.fromMat3(out, frame3));
}

const Z_AXIS: Vec3 = [0, 0, 1];

/** Body-space rotations of the hip (abduction about +Z), femur and tibia segments. */
export function legRotations(leg: Leg, hip: Quat, femur: Quat, tibia: Quat): void {
  quat.setAxisAngle(hip, Z_AXIS, leg.abduction);
  segmentRotation(femur, leg.axis, leg.femurBase, leg.knee);
  segmentRotation(tibia, leg.axis, leg.knee, leg.foot);
}
