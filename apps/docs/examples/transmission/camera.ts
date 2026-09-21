import { perspectiveCamera } from "vgpu/scene";

const FOV = 42;
const TARGET = [0, 0.05, 0] as const;
const CUBE_YAW = 0.62;

export const ORBIT_RADIUS = 4.1;
export const MIN_RADIUS = 2.6;
export const MAX_RADIUS = 7.5;
export const DEFAULT_YAW = CUBE_YAW + 0.63;
export const DEFAULT_PITCH = 0.42;

export interface CameraView {
  readonly viewProjection: ReturnType<
    typeof perspectiveCamera
  >["viewProjection"];
  readonly position: readonly [number, number, number];
  readonly forward: readonly [number, number, number];
  readonly right: readonly [number, number, number];
  readonly up: readonly [number, number, number];
  readonly tanHalfFov: number;
  readonly aspect: number;
}

export function cameraView(
  yaw: number,
  pitch: number,
  aspect: number,
  radius = ORBIT_RADIUS
): CameraView {
  pitch = Math.max(-1.2, Math.min(1.2, pitch));
  radius = Math.max(MIN_RADIUS, Math.min(MAX_RADIUS, radius));
  const cosPitch = Math.cos(pitch);
  const position: [number, number, number] = [
    TARGET[0] + Math.sin(yaw) * cosPitch * radius,
    TARGET[1] + Math.sin(pitch) * radius,
    TARGET[2] + Math.cos(yaw) * cosPitch * radius,
  ];
  const forward = normalize([
    TARGET[0] - position[0],
    TARGET[1] - position[1],
    TARGET[2] - position[2],
  ]);
  const right = normalize(cross(forward, [0, 1, 0]));
  const up = cross(right, forward);
  const camera = perspectiveCamera({
    fov: FOV,
    aspect,
    near: 0.1,
    far: 200,
    position,
    target: [...TARGET],
  });
  return {
    viewProjection: camera.viewProjection,
    position,
    forward,
    right,
    up,
    tanHalfFov: Math.tan((FOV * Math.PI) / 360),
    aspect,
  };
}

const cy = Math.cos(CUBE_YAW);
const sy = Math.sin(CUBE_YAW);
const cp = Math.cos(0.28);
const sp = Math.sin(0.28);

export const MODEL_MATRIX = new Float32Array([
  cy,
  0,
  -sy,
  0,
  sy * sp,
  cp,
  cy * sp,
  0,
  sy * cp,
  -sp,
  cy * cp,
  0,
  0,
  0,
  0,
  1,
]);

export const FLOOR_MATRIX = new Float32Array([
  1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -1.05, 0, 1,
]);

type Vec3 = readonly [number, number, number];

function cross(a: Vec3, b: Vec3): [number, number, number] {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function normalize(v: Vec3): [number, number, number] {
  const length = Math.hypot(...v) || 1;
  return [v[0] / length, v[1] / length, v[2] / length];
}
