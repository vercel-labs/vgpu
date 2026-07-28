import { perspectiveCamera, type SceneCamera } from 'vgpu/scene';

export const FOV_DEGREES = 42;
export const ORBIT_RADIUS = 4.1;
export const MIN_RADIUS = 2.6;
export const MAX_RADIUS = 7.5;
/** The cube sits at the origin; the orbit looks slightly above it so the floor stays in frame. */
export const TARGET: readonly [number, number, number] = [0, 0.05, 0];

/** Yaw of the cube's resting pose, in radians. The camera is offset from it on purpose. */
export const CUBE_YAW = 0.62;
/**
 * Opening view: 36° off the cube's own yaw, so two vertical faces stay visible at once.
 * Head-on (camera yaw ≈ CUBE_YAW) flattens the cube into a single square and hides the
 * second refraction, which is the whole point of the example.
 */
export const DEFAULT_YAW = CUBE_YAW + 0.63;
/** Just above the horizon: high enough to read the floor through the glass, low enough to keep the sky. */
export const DEFAULT_PITCH = 0.42;

export interface CameraView {
  /** View-projection consumed by the cube, floor and backface draws. */
  readonly camera: SceneCamera;
  readonly position: readonly [number, number, number];
  /** Orthonormal basis + tangent, used by the background pass to rebuild primary rays. */
  readonly forward: readonly [number, number, number];
  readonly right: readonly [number, number, number];
  readonly up: readonly [number, number, number];
  readonly tanHalfFov: number;
  readonly aspect: number;
}

/**
 * Builds one camera in two forms that must agree: a view-projection matrix for
 * rasterizing the cube and the floor, and a ray basis for the background pass that fills
 * the scene target behind them.
 */
export function cameraView(yaw: number, pitch: number, aspect: number, radius = ORBIT_RADIUS): CameraView {
  const clampedPitch = Math.max(-1.2, Math.min(1.2, pitch));
  const clampedRadius = Math.max(MIN_RADIUS, Math.min(MAX_RADIUS, radius));
  const cosPitch = Math.cos(clampedPitch);
  const position: [number, number, number] = [
    TARGET[0] + Math.sin(yaw) * cosPitch * clampedRadius,
    TARGET[1] + Math.sin(clampedPitch) * clampedRadius,
    TARGET[2] + Math.cos(yaw) * cosPitch * clampedRadius,
  ];
  const forward = normalize([TARGET[0] - position[0], TARGET[1] - position[1], TARGET[2] - position[2]]);
  const right = normalize(cross(forward, [0, 1, 0]));
  const up = cross(right, forward);

  return {
    camera: perspectiveCamera({
      fov: FOV_DEGREES,
      aspect,
      near: 0.1,
      far: 200,
      position,
      target: [...TARGET] as [number, number, number],
    }),
    position,
    forward,
    right,
    up,
    tanHalfFov: Math.tan((FOV_DEGREES * Math.PI) / 360),
    aspect,
  };
}

/**
 * Column-major rotation (Y then X) for the cube's resting pose.
 *
 * Fixed, never time-driven: three faces have to stay visible so refraction through two
 * interfaces reads, and a still frame is what makes the thumbnail deterministic.
 */
export function modelMatrix(): Float32Array {
  const yaw = CUBE_YAW;
  const pitch = 0.28;
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  return new Float32Array([
    cy, 0, -sy, 0,
    sy * sp, cp, cy * sp, 0,
    sy * cp, -sp, cy * cp, 0,
    0, 0, 0, 1,
  ]);
}

/** Column-major translation, the floor's only transform. */
export function translationMatrix(x: number, y: number, z: number): Float32Array {
  return new Float32Array([
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    x, y, z, 1,
  ]);
}

type Vec3 = readonly [number, number, number];

function cross(a: Vec3, b: Vec3): [number, number, number] {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function normalize(v: Vec3): [number, number, number] {
  const length = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / length, v[1] / length, v[2] / length];
}
