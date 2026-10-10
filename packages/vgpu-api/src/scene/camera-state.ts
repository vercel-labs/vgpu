import { VGPUError } from "../errors.ts";
import type { Mat4 } from "./transforms.ts";
import { byteRangesOverlap, isFiniteFloat32, readFiniteValues, valueError } from "./validation.ts";

const HALF_PI = Math.PI / 2;
const DEFAULT_PITCH_MARGIN = 1e-4;
const DEFAULT_DISTANCE_MIN = 1e-4;
const DEFAULT_FOV_MIN = 1e-4;
const DEFAULT_FOV_MAX = 180 - 1e-4;

export interface OrbitRig {
  target: Float32Array;
  pan: Float32Array;
  yaw: number;
  pitch: number;
  distance: number;
}

export interface OrbitRigOptions {
  target?: ArrayLike<number>;
  pan?: ArrayLike<number>;
  yaw?: number;
  pitch?: number;
  distance?: number;
}

export interface RigLimits {
  minPitch?: number;
  maxPitch?: number;
  minDistance?: number;
  maxDistance?: number;
}

export interface Pose {
  position: Float32Array;
  quaternion: Float32Array;
}

export interface Lens {
  fov: number;
  near: number;
  far: number;
}

export interface CameraMatrices {
  view: Mat4;
  viewProjection: Mat4;
}

export function orbitRig(initial: OrbitRigOptions = {}): OrbitRig {
  const target = readCameraVector(initial.target ?? [0, 0, 0], "orbitRig", "target");
  const pan = readCameraVector(initial.pan ?? [0, 0, 0], "orbitRig", "pan");
  const yaw = initial.yaw ?? 0;
  const pitch = initial.pitch ?? 0;
  const distance = initial.distance ?? 1;
  assertFinite(yaw, "orbitRig", "yaw");
  assertPitch(pitch, "orbitRig", "pitch");
  assertPositive(distance, "orbitRig", "distance");
  return { target: new Float32Array(target), pan: new Float32Array(pan), yaw, pitch, distance };
}

export function orbit(rig: OrbitRig, deltaYaw: number, deltaPitch: number, limits?: RigLimits): OrbitRig {
  const range = readRigLimits(limits, "orbit");
  assertRig(rig, "orbit");
  assertFinite(deltaYaw, "orbit", "deltaYaw");
  assertFinite(deltaPitch, "orbit", "deltaPitch");
  const yaw = rig.yaw + deltaYaw;
  const unclampedPitch = rig.pitch + deltaPitch;
  if (!Number.isFinite(yaw) || !Number.isFinite(unclampedPitch)) {
    throw cameraValueError(
      "orbit",
      "result",
      "the requested yaw or pitch overflows to a non-finite value",
      "Use finite deltas that keep the resulting yaw and pitch finite.",
    );
  }
  const pitch = clamp(unclampedPitch, range.minPitch, range.maxPitch);
  rig.yaw = yaw;
  rig.pitch = pitch;
  return rig;
}

export function pan(rig: OrbitRig, right: number, up: number): OrbitRig {
  const state = readRig(rig, "pan");
  assertFinite(right, "pan", "right");
  assertFinite(up, "pan", "up");

  const sinYaw = Math.sin(state.yaw);
  const cosYaw = Math.cos(state.yaw);
  const sinPitch = Math.sin(state.pitch);
  const cosPitch = Math.cos(state.pitch);
  const staged = finiteFloat32Vector([
    state.pan[0]! + right * cosYaw - up * sinYaw * sinPitch,
    state.pan[1]! + up * cosPitch,
    state.pan[2]! - right * sinYaw - up * cosYaw * sinPitch,
  ], "pan", "pan");
  rig.pan.set(staged);
  return rig;
}

export function dolly(rig: OrbitRig, factor: number, limits?: RigLimits): OrbitRig {
  const range = readRigLimits(limits, "dolly");
  assertRig(rig, "dolly");
  assertPositive(factor, "dolly", "factor");
  const candidate = rig.distance * factor;
  if (!Number.isFinite(candidate)) {
    throw cameraValueError(
      "dolly",
      "result.distance",
      "the requested distance overflows to a non-finite value",
      "Use a finite positive factor that keeps the resulting distance finite.",
    );
  }
  rig.distance = clamp(candidate, range.minDistance, range.maxDistance);
  return rig;
}

export function zoom(
  lens: Lens,
  factor: number,
  limits: { minFov?: number; maxFov?: number } = {},
): Lens {
  const range = readFovLimits(limits, "zoom");
  assertLens(lens, "zoom");
  assertPositive(factor, "zoom", "factor");
  const radians = lens.fov * Math.PI / 180;
  const candidate = 2 * Math.atan(Math.tan(radians / 2) / factor) * 180 / Math.PI;
  if (!Number.isFinite(candidate)) {
    throw cameraValueError(
      "zoom",
      "result.fov",
      "the requested field of view is not finite",
      "Use a finite positive factor that produces a finite field of view.",
    );
  }
  lens.fov = clamp(candidate, range.minFov, range.maxFov);
  return lens;
}

export function rigPose(rig: OrbitRig, out: Pose): Pose {
  const state = readRig(rig, "rigPose");
  assertVectorLength(out.position, 3, "rigPose", "out.position");
  assertVectorLength(out.quaternion, 4, "rigPose", "out.quaternion");
  if (byteRangesOverlap(out.position, out.quaternion)) {
    throw cameraAliasError(
      "rigPose",
      "out.position",
      "out.position and out.quaternion overlap",
      "Allocate disjoint position and quaternion output arrays.",
    );
  }

  const sinYaw = Math.sin(state.yaw);
  const cosYaw = Math.cos(state.yaw);
  const sinPitch = Math.sin(state.pitch);
  const cosPitch = Math.cos(state.pitch);
  const position = finiteFloat32Vector([
    state.target[0]! + state.pan[0]! + state.distance * cosPitch * sinYaw,
    state.target[1]! + state.pan[1]! + state.distance * sinPitch,
    state.target[2]! + state.pan[2]! + state.distance * cosPitch * cosYaw,
  ], "rigPose", "out.position");
  const halfYaw = state.yaw / 2;
  const halfPitch = state.pitch / 2;
  const quaternion = finiteFloat32Vector([
    -Math.cos(halfYaw) * Math.sin(halfPitch),
    Math.sin(halfYaw) * Math.cos(halfPitch),
    Math.sin(halfYaw) * Math.sin(halfPitch),
    Math.cos(halfYaw) * Math.cos(halfPitch),
  ], "rigPose", "out.quaternion");

  out.position.set(position);
  out.quaternion.set(quaternion);
  return out;
}

export function perspective(lens: Lens, aspect: number, out: Mat4): Mat4 {
  assertLens(lens, "perspective");
  assertPositive(aspect, "perspective", "aspect");
  assertVectorLength(out, 16, "perspective", "out");
  const f = 1 / Math.tan(lens.fov * Math.PI / 360);
  const range = 1 / (lens.near - lens.far);
  const staged = finiteFloat32Vector([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, lens.far * range, -1,
    0, 0, lens.far * lens.near * range, 0,
  ], "perspective", "out");
  out.set(staged);
  return out;
}

export function orthographic(
  bounds: { left: number; right: number; bottom: number; top: number; near: number; far: number },
  out: Mat4,
): Mat4 {
  for (const field of ["left", "right", "bottom", "top", "near", "far"] as const) {
    assertFinite(bounds[field], "orthographic", `bounds.${field}`);
  }
  if (bounds.left >= bounds.right) {
    throw cameraValueError("orthographic", "bounds", "left is not less than right", "Pass ordered horizontal bounds with left < right.");
  }
  if (bounds.bottom >= bounds.top) {
    throw cameraValueError("orthographic", "bounds", "bottom is not less than top", "Pass ordered vertical bounds with bottom < top.");
  }
  if (bounds.near < 0 || bounds.near >= bounds.far) {
    throw cameraValueError("orthographic", "bounds", "near and far do not satisfy 0 <= near < far", "Pass depth bounds with 0 <= near < far.");
  }
  assertVectorLength(out, 16, "orthographic", "out");
  const staged = finiteFloat32Vector([
    2 / (bounds.right - bounds.left), 0, 0, 0,
    0, 2 / (bounds.top - bounds.bottom), 0, 0,
    0, 0, 1 / (bounds.near - bounds.far), 0,
    (bounds.right + bounds.left) / (bounds.left - bounds.right),
    (bounds.top + bounds.bottom) / (bounds.bottom - bounds.top),
    bounds.near / (bounds.near - bounds.far), 1,
  ], "orthographic", "out");
  out.set(staged);
  return out;
}

export function viewMatrices(pose: Pose, projection: ArrayLike<number>, out: CameraMatrices): void {
  const position = readCameraVector(pose.position, "viewMatrices", "pose.position");
  const quaternion = readQuaternion(pose.quaternion, "viewMatrices", "pose.quaternion");
  assertVectorLength(projection, 16, "viewMatrices", "projection");
  const projectionValues = readFiniteValues(projection, 16, "viewMatrices", "projection", "VGPU-CAMERA-VALUE");
  assertVectorLength(out.view, 16, "viewMatrices", "out.view");
  assertVectorLength(out.viewProjection, 16, "viewMatrices", "out.viewProjection");
  if (byteRangesOverlap(out.view, out.viewProjection)) {
    throw cameraAliasError(
      "viewMatrices",
      "out.view",
      "out.view and out.viewProjection overlap",
      "Allocate disjoint view and viewProjection output matrices.",
    );
  }

  const x = quaternion[0]!, y = quaternion[1]!, z = quaternion[2]!, w = quaternion[3]!;
  const xx = x * x, xy = x * y, xz = x * z;
  const yy = y * y, yz = y * z, zz = z * z;
  const wx = w * x, wy = w * y, wz = w * z;
  const r00 = 1 - 2 * (yy + zz), r10 = 2 * (xy + wz), r20 = 2 * (xz - wy);
  const r01 = 2 * (xy - wz), r11 = 1 - 2 * (xx + zz), r21 = 2 * (yz + wx);
  const r02 = 2 * (xz + wy), r12 = 2 * (yz - wx), r22 = 1 - 2 * (xx + yy);
  const px = position[0]!, py = position[1]!, pz = position[2]!;
  const view = finiteFloat32Vector([
    r00, r01, r02, 0,
    r10, r11, r12, 0,
    r20, r21, r22, 0,
    -(r00 * px + r10 * py + r20 * pz),
    -(r01 * px + r11 * py + r21 * pz),
    -(r02 * px + r12 * py + r22 * pz),
    1,
  ], "viewMatrices", "out.view");
  const viewProjection = finiteFloat32Vector(
    multiplyMatrixValues(projectionValues, view),
    "viewMatrices",
    "out.viewProjection",
  );
  out.view.set(view);
  out.viewProjection.set(viewProjection);
}

export function smoothRig(
  current: OrbitRig,
  goal: OrbitRig,
  dt: number,
  options: { timeConstant: number },
): OrbitRig {
  if (current === goal) {
    throw cameraAliasError(
      "smoothRig",
      "current",
      "current and goal are the same object",
      "Use independent current and goal rig objects.",
    );
  }
  const currentState = readRig(current, "smoothRig");
  const goalState = readRig(goal, "smoothRig");
  assertRigSeparation(current, goal);
  assertNonnegative(dt, "smoothRig", "dt");
  assertNonnegative(options.timeConstant, "smoothRig", "options.timeConstant");
  const k = options.timeConstant === 0 ? 1 : -Math.expm1(-dt / options.timeConstant);
  if (!Number.isFinite(k) || k < 0 || k > 1) {
    throw cameraValueError("smoothRig", "result.k", "the smoothing fraction is outside [0, 1]", "Pass finite nonnegative dt and timeConstant values.");
  }
  const inverseK = 1 - k;
  const mix = (from: number, to: number): number => k === 0 ? from : k === 1 ? to : from * inverseK + to * k;
  const target = finiteFloat32Vector([
    mix(currentState.target[0]!, goalState.target[0]!),
    mix(currentState.target[1]!, goalState.target[1]!),
    mix(currentState.target[2]!, goalState.target[2]!),
  ], "smoothRig", "current.target");
  const panValue = finiteFloat32Vector([
    mix(currentState.pan[0]!, goalState.pan[0]!),
    mix(currentState.pan[1]!, goalState.pan[1]!),
    mix(currentState.pan[2]!, goalState.pan[2]!),
  ], "smoothRig", "current.pan");
  const yaw = mix(currentState.yaw, goalState.yaw);
  const pitch = mix(currentState.pitch, goalState.pitch);
  const distance = k === 0 ? currentState.distance : k === 1 ? goalState.distance
    : Math.exp(Math.log(currentState.distance) * inverseK + Math.log(goalState.distance) * k);
  assertFinite(yaw, "smoothRig", "result.yaw");
  assertPitch(pitch, "smoothRig", "result.pitch");
  assertPositive(distance, "smoothRig", "result.distance");

  current.target.set(target);
  current.pan.set(panValue);
  current.yaw = yaw;
  current.pitch = pitch;
  current.distance = distance;
  return current;
}

export function worldPerPixel(distance: number, lens: Lens, heightPixels: number): number {
  assertPositive(distance, "worldPerPixel", "distance");
  assertLens(lens, "worldPerPixel");
  assertPositive(heightPixels, "worldPerPixel", "heightPixels");
  const result = 2 * distance * Math.tan(lens.fov * Math.PI / 360) / heightPixels;
  if (!Number.isFinite(result) || result <= 0) {
    throw cameraValueError(
      "worldPerPixel",
      "result",
      "the world-units-per-pixel result is not finite and positive",
      "Use finite positive distance and height values whose result remains finite.",
    );
  }
  return result;
}

function readRig(rig: OrbitRig, operation: string): { target: number[]; pan: number[]; yaw: number; pitch: number; distance: number } {
  const target = readCameraVector(rig.target, operation, "rig.target");
  const pan = readCameraVector(rig.pan, operation, "rig.pan");
  assertFinite(rig.yaw, operation, "rig.yaw");
  assertPitch(rig.pitch, operation, "rig.pitch");
  assertPositive(rig.distance, operation, "rig.distance");
  return { target, pan, yaw: rig.yaw, pitch: rig.pitch, distance: rig.distance };
}

function assertRig(rig: OrbitRig, operation: string): void {
  readRig(rig, operation);
}

function assertLens(lens: Lens, operation: string): void {
  if (!Number.isFinite(lens.fov) || lens.fov <= 0 || lens.fov >= 180) {
    throw cameraValueError(
      operation,
      "lens.fov",
      `${String(lens.fov)} is outside the open interval (0, 180) degrees`,
      "Pass a finite vertical field of view strictly between 0 and 180 degrees.",
    );
  }
  if (!Number.isFinite(lens.near) || lens.near <= 0) {
    throw cameraValueError(operation, "lens.near", `${String(lens.near)} is not finite and positive`, "Pass a finite positive near plane.");
  }
  if (!Number.isFinite(lens.far) || lens.far <= lens.near) {
    throw cameraValueError(operation, "lens.far", `${String(lens.far)} is not finite and greater than near`, "Pass a finite far plane greater than near.");
  }
}

function readRigLimits(limits: RigLimits = {}, operation: string): Required<RigLimits> {
  const minPitch = limits.minPitch ?? -HALF_PI + DEFAULT_PITCH_MARGIN;
  const maxPitch = limits.maxPitch ?? HALF_PI - DEFAULT_PITCH_MARGIN;
  const minDistance = limits.minDistance ?? DEFAULT_DISTANCE_MIN;
  const maxDistance = limits.maxDistance ?? Infinity;
  assertPitch(minPitch, operation, "limits.minPitch");
  assertPitch(maxPitch, operation, "limits.maxPitch");
  if (minPitch > maxPitch) {
    throw cameraValueError(operation, "limits", "minPitch is greater than maxPitch", "Pass ordered pitch limits with minPitch <= maxPitch.");
  }
  assertPositive(minDistance, operation, "limits.minDistance");
  if ((maxDistance !== Infinity && !Number.isFinite(maxDistance)) || maxDistance <= 0) {
    throw cameraValueError(operation, "limits.maxDistance", `${String(maxDistance)} is not positive and finite or Infinity`, "Pass a positive finite maxDistance or Infinity.");
  }
  if (minDistance > maxDistance) {
    throw cameraValueError(operation, "limits", "minDistance is greater than maxDistance", "Pass ordered distance limits with minDistance <= maxDistance.");
  }
  return { minPitch, maxPitch, minDistance, maxDistance };
}

function readFovLimits(limits: { minFov?: number; maxFov?: number }, operation: string): { minFov: number; maxFov: number } {
  const minFov = limits.minFov ?? DEFAULT_FOV_MIN;
  const maxFov = limits.maxFov ?? DEFAULT_FOV_MAX;
  if (!Number.isFinite(minFov) || minFov <= 0 || minFov >= 180) {
    throw cameraValueError(operation, "limits.minFov", `${String(minFov)} is outside (0, 180)`, "Pass minFov strictly between 0 and 180 degrees.");
  }
  if (!Number.isFinite(maxFov) || maxFov <= 0 || maxFov >= 180) {
    throw cameraValueError(operation, "limits.maxFov", `${String(maxFov)} is outside (0, 180)`, "Pass maxFov strictly between 0 and 180 degrees.");
  }
  if (minFov > maxFov) {
    throw cameraValueError(operation, "limits", "minFov is greater than maxFov", "Pass ordered FOV limits with minFov <= maxFov.");
  }
  return { minFov, maxFov };
}

function finiteFloat32Vector(values: readonly number[], operation: string, field: string): Float32Array {
  for (let index = 0; index < values.length; index++) {
    if (!isFiniteFloat32(values[index]!)) {
      throw cameraValueError(
        operation,
        `${field}[${index}]`,
        "the result is not representable as finite float32",
        "Use finite camera values whose result fits in float32.",
      );
    }
  }
  return new Float32Array(values);
}

function readQuaternion(value: ArrayLike<number>, operation: string, field: string): number[] {
  assertVectorLength(value, 4, operation, field);
  const quaternion = readFiniteValues(value, 4, operation, field, "VGPU-CAMERA-VALUE");
  const length = Math.hypot(quaternion[0]!, quaternion[1]!, quaternion[2]!, quaternion[3]!);
  if (length === 0 || !Number.isFinite(length)) {
    throw cameraValueError(operation, field, "the quaternion has zero or non-finite length", "Pass a finite nonzero XYZW quaternion.");
  }
  return quaternion.map((component) => component / length);
}

function multiplyMatrixValues(a: ArrayLike<number>, b: ArrayLike<number>): number[] {
  const result = new Array<number>(16);
  for (let column = 0; column < 4; column++) {
    const offset = column * 4;
    const b0 = b[offset]!, b1 = b[offset + 1]!, b2 = b[offset + 2]!, b3 = b[offset + 3]!;
    result[offset] = a[0]! * b0 + a[4]! * b1 + a[8]! * b2 + a[12]! * b3;
    result[offset + 1] = a[1]! * b0 + a[5]! * b1 + a[9]! * b2 + a[13]! * b3;
    result[offset + 2] = a[2]! * b0 + a[6]! * b1 + a[10]! * b2 + a[14]! * b3;
    result[offset + 3] = a[3]! * b0 + a[7]! * b1 + a[11]! * b2 + a[15]! * b3;
  }
  return result;
}

function assertVectorLength(value: ArrayLike<number>, required: number, operation: string, field: string): void {
  if (value.length !== required) throw cameraSizeError(operation, field, value.length, required);
}

function cameraAliasError(operation: string, field: string, problem: string, fix: string): VGPUError {
  return new VGPUError({
    code: "VGPU-CAMERA-ALIAS",
    message: `${operation} cannot use overlapping camera storage: ${problem}.`,
    fix,
    where: `${operation}.${field}`,
  });
}

function assertRigSeparation(current: OrbitRig, goal: OrbitRig): void {
  if (byteRangesOverlap(current.target, current.pan)) {
    throw cameraAliasError(
      "smoothRig",
      "current.target",
      "current.target and current.pan overlap",
      "Allocate disjoint writable vectors for the current rig.",
    );
  }
  for (const [currentName, currentVector] of [["target", current.target], ["pan", current.pan]] as const) {
    for (const [goalName, goalVector] of [["target", goal.target], ["pan", goal.pan]] as const) {
      if (byteRangesOverlap(currentVector, goalVector)) {
        throw cameraAliasError(
          "smoothRig",
          `current.${currentName}`,
          `current.${currentName} overlaps goal.${goalName}`,
          "Allocate independent current and goal rig vectors.",
        );
      }
    }
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function readCameraVector(value: ArrayLike<number>, operation: string, field: string): number[] {
  if (value.length !== 3) throw cameraSizeError(operation, field, value.length, 3);
  const staged = readFiniteValues(value, 3, operation, field, "VGPU-CAMERA-VALUE");
  for (let index = 0; index < staged.length; index++) {
    if (!isFiniteFloat32(staged[index]!)) {
      throw cameraValueError(
        operation,
        `${field}[${index}]`,
        "the value is outside finite float32 range",
        `Pass ${field} components representable as finite float32 values.`,
      );
    }
  }
  return staged;
}

function assertFinite(value: number, operation: string, field: string): void {
  if (!Number.isFinite(value)) {
    throw cameraValueError(operation, field, `${String(value)} is not finite`, `Pass a finite number for ${field}.`);
  }
}

function assertPitch(value: number, operation: string, field: string): void {
  if (!Number.isFinite(value) || value <= -HALF_PI || value >= HALF_PI) {
    throw cameraValueError(
      operation,
      field,
      `${String(value)} is outside the open interval (-pi/2, pi/2)`,
      `Pass ${field} strictly between -pi/2 and pi/2 radians.`,
    );
  }
}

function assertPositive(value: number, operation: string, field: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw cameraValueError(operation, field, `${String(value)} is not finite and positive`, `Pass a finite positive ${field}.`);
  }
}

function assertNonnegative(value: number, operation: string, field: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw cameraValueError(operation, field, `${String(value)} is not finite and nonnegative`, `Pass a finite nonnegative ${field}.`);
  }
}

function cameraValueError(operation: string, field: string, problem: string, fix: string): VGPUError {
  return valueError("VGPU-CAMERA-VALUE", operation, field, problem, fix);
}

function cameraSizeError(operation: string, field: string, actual: number, required: number): VGPUError {
  return new VGPUError({
    code: "VGPU-CAMERA-SIZE",
    message: `${operation} received ${field} with ${actual} values; exactly ${required} are required.`,
    fix: `Allocate ${field} with exactly ${required} values.`,
    where: `${operation}.${field}`,
  });
}
