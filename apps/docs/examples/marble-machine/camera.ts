import {
  group,
  orbit,
  orbitRig,
  orthographic,
  perspective,
  rigPose,
  smoothRig,
  viewMatrices,
  type CameraMatrices,
  type Lens,
  type OrbitRig,
  type Pose,
} from 'vgpu/scene';

import { MACHINE_BOUNDS } from './machine';
import type { Marble, Simulation } from './simulation';

/** Machine frames the whole run; follow tracks the newest marble still on the ramps. */
export type CameraMode = 'machine' | 'follow';

/** The camera state this example owns: a goal rig the input writes and a smoothed rig it views. */
export interface Camera {
  readonly goal: OrbitRig;
  readonly current: OrbitRig;
  readonly lens: Lens;
  readonly pose: Pose;
  readonly projection: Float32Array;
  readonly matrices: CameraMatrices;
  /** Zoom multiplier on the fitted distance; < 1 is closer. */
  zoom: number;
  mode: CameraMode;
}

/** What the camera should frame this frame: a box given by its centre and half size. */
export interface Focus {
  readonly center: Float32Array;
  readonly halfSize: Float32Array;
  /** Simulation id of the marble follow mode rides with, or -1. */
  followed: number;
}

export const DEFAULT_VIEW = { yaw: 0.34, pitch: 0.3, zoom: 1 } as const;
export const PITCH_LIMITS = { minPitch: -0.05, maxPitch: 1.15 } as const;
/** The back of the machine is a plain board; keep the orbit in front of it. */
export const YAW_LIMIT = 1.2;
export const ZOOM_LIMITS = { min: 0.45, max: 1.6 } as const;
const LENS: Lens = { fov: 30, near: 0.5, far: 200 };
/** Share of the frame the focus box may fill on its tighter axis. */
const FILL = 0.92;

const MACHINE_CENTER = [
  (MACHINE_BOUNDS.min[0] + MACHINE_BOUNDS.max[0]) / 2,
  (MACHINE_BOUNDS.min[1] + MACHINE_BOUNDS.max[1]) / 2,
  (MACHINE_BOUNDS.min[2] + MACHINE_BOUNDS.max[2]) / 2,
] as const;
const MACHINE_HALF_SIZE = [
  (MACHINE_BOUNDS.max[0] - MACHINE_BOUNDS.min[0]) / 2,
  (MACHINE_BOUNDS.max[1] - MACHINE_BOUNDS.min[1]) / 2,
  (MACHINE_BOUNDS.max[2] - MACHINE_BOUNDS.min[2]) / 2,
] as const;
/** Follow mode frames a box this size around the marble, about one ramp and the next. */
const FOLLOW_HALF_SIZE = [1.5, 0.85, 0.35] as const;
/** Marbles below this height are in the tray; follow mode ignores them. */
const FOLLOW_MIN_Y = 0.6;

export function createCamera(): Camera {
  const initial = { target: MACHINE_CENTER, yaw: DEFAULT_VIEW.yaw, pitch: DEFAULT_VIEW.pitch, distance: 12 };
  return {
    goal: orbitRig(initial),
    current: orbitRig(initial),
    lens: { ...LENS },
    pose: { position: new Float32Array(3), quaternion: new Float32Array(4) },
    projection: new Float32Array(16),
    matrices: { view: new Float32Array(16), viewProjection: new Float32Array(16) },
    zoom: DEFAULT_VIEW.zoom,
    mode: 'machine',
  };
}

export function createFocus(): Focus {
  return { center: new Float32Array(MACHINE_CENTER), halfSize: new Float32Array(MACHINE_HALF_SIZE), followed: -1 };
}

/**
 * Aims `rig` (its yaw and pitch stay) so the focus box fills `FILL` of the frame on its tighter
 * axis and sits centred. Each box corner needs distance >= its offset across the view divided by
 * the field-of-view slope, plus its depth toward the lens; two passes re-centre the target on the
 * projected box, since perspective makes the near half look bigger.
 */
export function fitRig(rig: OrbitRig, focus: Focus, fovDegrees: number, aspect: number): void {
  const tanVertical = Math.tan((fovDegrees * Math.PI) / 360) * FILL;
  const tanHorizontal = tanVertical * aspect;
  const sinYaw = Math.sin(rig.yaw);
  const cosYaw = Math.cos(rig.yaw);
  const sinPitch = Math.sin(rig.pitch);
  const cosPitch = Math.cos(rig.pitch);
  // Camera basis for this yaw and pitch (see rigPose): back points from the target to the lens.
  const back = [cosPitch * sinYaw, sinPitch, cosPitch * cosYaw];
  const right = [cosYaw, 0, -sinYaw];
  const up = [-sinPitch * sinYaw, cosPitch, -sinPitch * cosYaw];
  rig.target.set(focus.center);
  for (let pass = 0; pass < 3; pass += 1) {
    let distance = 0;
    for (let corner = 0; corner < 8; corner += 1) {
      const offset = cornerOffset(rig, focus, corner);
      const toward = dot(offset, back);
      distance = Math.max(
        distance,
        Math.abs(dot(offset, right)) / tanHorizontal + toward,
        Math.abs(dot(offset, up)) / tanVertical + toward,
      );
    }
    rig.distance = distance;
    if (pass === 2) return;
    // Projected extent of the box in units of the frame half size.
    let left = Infinity;
    let rightMost = -Infinity;
    let bottom = Infinity;
    let top = -Infinity;
    for (let corner = 0; corner < 8; corner += 1) {
      const offset = cornerOffset(rig, focus, corner);
      const depth = distance - dot(offset, back);
      const x = dot(offset, right) / (tanHorizontal * depth);
      const y = dot(offset, up) / (tanVertical * depth);
      left = Math.min(left, x);
      rightMost = Math.max(rightMost, x);
      bottom = Math.min(bottom, y);
      top = Math.max(top, y);
    }
    const shiftX = ((left + rightMost) / 2) * tanHorizontal * distance;
    const shiftY = ((bottom + top) / 2) * tanVertical * distance;
    for (let axis = 0; axis < 3; axis += 1) {
      rig.target[axis] = rig.target[axis]! + right[axis]! * shiftX + up[axis]! * shiftY;
    }
  }
}

const scratchOffset = [0, 0, 0];

function cornerOffset(rig: OrbitRig, focus: Focus, corner: number): number[] {
  for (let axis = 0; axis < 3; axis += 1) {
    const sign = corner & (1 << axis) ? 1 : -1;
    scratchOffset[axis] = focus.center[axis]! + sign * focus.halfSize[axis]! - rig.target[axis]!;
  }
  return scratchOffset;
}

function dot(a: readonly number[], b: readonly number[]): number {
  return a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
}

export function orbitBy(camera: Camera, deltaYaw: number, deltaPitch: number): void {
  orbit(camera.goal, deltaYaw, deltaPitch, PITCH_LIMITS);
  camera.goal.yaw = Math.min(YAW_LIMIT, Math.max(-YAW_LIMIT, camera.goal.yaw));
}

export function zoomBy(camera: Camera, factor: number): void {
  camera.zoom = Math.min(ZOOM_LIMITS.max, Math.max(ZOOM_LIMITS.min, camera.zoom * factor));
}

export function resetView(camera: Camera): void {
  camera.goal.yaw = DEFAULT_VIEW.yaw;
  camera.goal.pitch = DEFAULT_VIEW.pitch;
  camera.zoom = DEFAULT_VIEW.zoom;
}

function followable(marble: Marble): boolean {
  return marble.retiredAt < 0 && marble.body.position.y >= FOLLOW_MIN_Y;
}

/**
 * Writes this frame's focus: the whole machine, or in follow mode one marble from the hopper
 * to the tray. When it lands, the newest marble still on the ramps takes over; with none, the
 * whole machine.
 */
export function updateFocus(focus: Focus, mode: CameraMode, simulation: Simulation): Focus {
  if (mode === 'follow') {
    const { marbles } = simulation;
    let marble = marbles.find((candidate) => candidate.id === focus.followed);
    if (!marble || !followable(marble)) {
      marble = marbles.findLast(followable);
      focus.followed = marble?.id ?? -1;
    }
    if (marble) {
      const { x, y } = marble.body.position;
      // Lean the frame toward the machine centre and down, so the ramp below stays in view.
      focus.center[0] = x * 0.8;
      focus.center[1] = y - 0.3;
      focus.center[2] = 0;
      focus.halfSize.set(FOLLOW_HALF_SIZE);
      return focus;
    }
  }
  focus.followed = -1;
  focus.center.set(MACHINE_CENTER);
  focus.halfSize.set(MACHINE_HALF_SIZE);
  return focus;
}

/**
 * Fits the goal rig to the focus, smooths toward it and writes the view matrices.
 * `dt` = 0 snaps (thumbnails and the first frame).
 */
export function updateCamera(
  camera: Camera,
  focus: Focus,
  aspect: number,
  dt: number,
  timeConstant = 0.35,
): CameraMatrices {
  fitRig(camera.goal, focus, camera.lens.fov, aspect);
  camera.goal.distance *= camera.zoom;
  if (dt <= 0) {
    camera.current.target.set(camera.goal.target);
    camera.current.pan.set(camera.goal.pan);
    camera.current.yaw = camera.goal.yaw;
    camera.current.pitch = camera.goal.pitch;
    camera.current.distance = camera.goal.distance;
  } else {
    smoothRig(camera.current, camera.goal, Math.min(dt, 0.1), { timeConstant });
  }
  perspective(camera.lens, aspect, camera.projection);
  viewMatrices(rigPose(camera.current, camera.pose), camera.projection, camera.matrices);
  return camera.matrices;
}

/** Direction toward the key light: front-left and high, so shadows fall back onto the board. */
export const KEY_DIRECTION = normalize([-0.5, 0.86, 0.72]);

/**
 * The key light's orthographic view-projection, fitted to the machine bounds seen from the
 * light so the 2048² map spends its texels on the machine. Returns the world size of a texel.
 */
export function lightMatrices(out: CameraMatrices, mapSize: number): number {
  const center = [
    (MACHINE_BOUNDS.min[0] + MACHINE_BOUNDS.max[0]) / 2,
    (MACHINE_BOUNDS.min[1] + MACHINE_BOUNDS.max[1]) / 2,
    (MACHINE_BOUNDS.min[2] + MACHINE_BOUNDS.max[2]) / 2,
  ];
  const distance = 12;
  const eye = center.map((value, axis) => value + KEY_DIRECTION[axis]! * distance);
  const light = group({ position: eye }).lookAt(center);
  const pose: Pose = { position: new Float32Array(light.position), quaternion: new Float32Array(light.quaternion) };
  // A first pass with an identity projection gives the light's view matrix.
  const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  viewMatrices(pose, identity, out);
  const low = [Infinity, Infinity, Infinity];
  const high = [-Infinity, -Infinity, -Infinity];
  for (let corner = 0; corner < 8; corner += 1) {
    const point = [
      corner & 1 ? MACHINE_BOUNDS.max[0] : MACHINE_BOUNDS.min[0],
      corner & 2 ? MACHINE_BOUNDS.max[1] : MACHINE_BOUNDS.min[1],
      corner & 4 ? MACHINE_BOUNDS.max[2] : MACHINE_BOUNDS.min[2],
    ];
    for (let axis = 0; axis < 3; axis += 1) {
      const value =
        out.view[axis]! * point[0]! + out.view[4 + axis]! * point[1]! + out.view[8 + axis]! * point[2]! + out.view[12 + axis]!;
      low[axis] = Math.min(low[axis]!, value);
      high[axis] = Math.max(high[axis]!, value);
    }
  }
  const margin = 0.15;
  const projection = orthographic(
    {
      left: low[0]! - margin,
      right: high[0]! + margin,
      bottom: low[1]! - margin,
      top: high[1]! + margin,
      // View space looks down -z: the nearest corner has the largest z. A shadow on the
      // studio floor shares its caster's texel but lies up to ~8 units deeper along the ray.
      near: -high[2]! - 1,
      far: -low[2]! + 9,
    },
    new Float32Array(16),
  );
  viewMatrices(pose, projection, out);
  return Math.max(high[0]! - low[0]!, high[1]! - low[1]!) / mapSize;
}

function normalize(vector: readonly [number, number, number]): readonly [number, number, number] {
  const length = Math.hypot(...vector);
  return [vector[0] / length, vector[1] / length, vector[2] / length];
}
