/**
 * The one camera in the scene, and the wall it decides the size of.
 *
 * The wall is the picture: outside the rectangle the tracer painted there is
 * nothing, so a frame that saw past a corner of it would end in a hard edge
 * against an empty room. Rather than pick a wall size and hope, this module runs
 * the relationship the other way — `wallCoverage` walks the frustum's corners to
 * the wall plane and `wallHalfHeight` returns the size that covers the worst of
 * them, over every position the pointer can put the camera in.
 * `geometry.test.ts` holds that at every aspect a canvas can take.
 *
 * The pointer only ever moves the view a few degrees off its resting angle. That
 * is deliberate: the traced caustic lives in world space on the wall, so moving
 * the camera cannot invalidate it — the estimate keeps converging while the view
 * moves — and a small swing is enough to show the glass standing off the wall.
 */

import { perspectiveCamera, type SceneCamera } from 'vgpu/scene';

import {
  CAMERA_DISTANCE,
  CAMERA_FOV_DEGREES,
  CAMERA_ORBIT_DEGREES,
  CAMERA_PITCH_DEGREES,
  CAMERA_YAW_DEGREES,
} from './types';

type Vec3 = readonly [number, number, number];

/** Slack on the derived wall size; the coverage test holds this margin. */
const WALL_SAFETY = 1.02;

/**
 * Last answer from `wallHalfHeight`, which costs nine cameras and is read while
 * assembling uniforms. It only changes when the canvas does.
 */
let memoizedAspect = 0;
let memoizedHalfHeight = 0;

export interface CameraView {
  readonly camera: SceneCamera;
  readonly position: Vec3;
  /** Orthonormal basis: where the camera looks, and the frame's axes. */
  readonly forward: Vec3;
  readonly right: Vec3;
  readonly up: Vec3;
}

/**
 * The camera for a pointer position, both components in [-1, 1] with 0 at rest.
 *
 * It swings on a sphere around the origin and keeps looking at it, so the prism
 * stays put in the frame and only the parallax against the wall behind it moves.
 */
export function cameraView(aspect: number, orbitX = 0, orbitY = 0): CameraView {
  const limit = CAMERA_ORBIT_DEGREES;
  const yaw = radians(CAMERA_YAW_DEGREES + clamp(orbitX, -1, 1) * limit);
  const pitch = radians(CAMERA_PITCH_DEGREES - clamp(orbitY, -1, 1) * limit);
  const cosPitch = Math.cos(pitch);
  const position: Vec3 = [
    Math.sin(yaw) * cosPitch * CAMERA_DISTANCE,
    Math.sin(pitch) * CAMERA_DISTANCE,
    Math.cos(yaw) * cosPitch * CAMERA_DISTANCE,
  ];
  const forward = normalize([-position[0], -position[1], -position[2]]);
  const right = normalize(cross(forward, [0, 1, 0]));
  return {
    camera: perspectiveCamera({
      fov: CAMERA_FOV_DEGREES,
      aspect,
      // The whole scene sits between the wall at z = 0 and the glass in front of
      // it, so the depth range only has to bracket a couple of units.
      near: 0.05,
      far: 4 * CAMERA_DISTANCE,
      position,
      target: [0, 0, 0],
    }),
    position,
    forward,
    right,
    up: cross(right, forward),
  };
}

/**
 * Half-height of the wall, in scene units, for a canvas of this shape.
 *
 * Derived rather than chosen. An off-axis camera keystones the wall and a wide
 * canvas widens the frustum, so how much wall the frame needs depends on the
 * canvas: this returns the worst case over the pointer's whole swing, which is
 * exactly the size that guarantees the frame never sees past what was traced.
 * `WALL_SAFETY` covers the difference between the frustum corners this samples
 * and the continuous edge between them.
 *
 * Nothing optical scales with it. The prism, the lamp and their distances are
 * fixed in scene units, so a taller wall means a larger traced rectangle around
 * an unchanged scene — the same picture with more room in the corners, paid for
 * with caustic texels.
 */
export function wallHalfHeight(aspect: number): number {
  if (aspect === memoizedAspect) return memoizedHalfHeight;
  let worst = 0;
  for (const orbitX of [-1, 0, 1]) {
    for (const orbitY of [-1, 0, 1]) {
      worst = Math.max(worst, wallCoverage(aspect, orbitX, orbitY));
    }
  }
  memoizedAspect = aspect;
  memoizedHalfHeight = worst * WALL_SAFETY;
  return memoizedHalfHeight;
}

/**
 * How much of a unit-height wall the frame needs, as a fraction of it.
 *
 * Measured by walking the four corner rays of the frustum to the wall plane,
 * which is the only place a shortfall could appear.
 */
export function wallCoverage(aspect: number, orbitX = 0, orbitY = 0): number {
  const view = cameraView(aspect, orbitX, orbitY);
  const tanHalfFov = Math.tan(radians(CAMERA_FOV_DEGREES) / 2);
  let worst = 0;
  for (const horizontal of [-1, 1]) {
    for (const vertical of [-1, 1]) {
      const direction: Vec3 = [0, 1, 2].map((axis) =>
        view.forward[axis]!
        + view.right[axis]! * horizontal * tanHalfFov * aspect
        + view.up[axis]! * vertical * tanHalfFov) as unknown as Vec3;
      // The camera is on the +z side of the wall and looking towards it, so every
      // corner ray crosses z = 0 at a positive distance.
      if (direction[2] >= 0) return Infinity;
      const t = -view.position[2] / direction[2];
      const x = view.position[0] + direction[0] * t;
      const y = view.position[1] + direction[1] * t;
      worst = Math.max(worst, Math.abs(x) / aspect, Math.abs(y));
    }
  }
  return worst;
}

/**
 * Column-major XYZ rotation, used for the studio environment's orientation.
 *
 * Copied from `glass-fractal`, which turns its environment the same way and by
 * the same default angles.
 */
export function rotationMatrix(degrees: readonly [number, number, number]): Float32Array {
  const [x, y, z] = degrees.map(radians) as [number, number, number];
  const [sx, cx] = [Math.sin(x), Math.cos(x)];
  const [sy, cy] = [Math.sin(y), Math.cos(y)];
  const [sz, cz] = [Math.sin(z), Math.cos(z)];
  return new Float32Array([
    cy * cz, cy * sz, -sy, 0,
    sx * sy * cz - cx * sz, sx * sy * sz + cx * cz, sx * cy, 0,
    cx * sy * cz + sx * sz, cx * sy * sz - sx * cz, cx * cy, 0,
    0, 0, 0, 1,
  ]);
}

function radians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function normalize(value: Vec3): Vec3 {
  const length = Math.hypot(value[0], value[1], value[2]) || 1;
  return [value[0] / length, value[1] / length, value[2] / length];
}
