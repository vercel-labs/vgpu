export const DEFAULT_YAW = 0.9;
export const DEFAULT_PITCH = 0.28;
export const DEFAULT_RADIUS = 3.6;

const MIN_PITCH = -0.2;
const MAX_PITCH = 1.15;
const MIN_RADIUS = 1.6;
const MAX_RADIUS = 6.5;

export interface CameraState {
  readonly yaw: number;
  readonly pitch: number;
  readonly radius: number;
}

export function cameraState(yaw: number, pitch: number, radius: number): CameraState {
  return {
    yaw,
    pitch: clampPitch(pitch),
    radius: clampRadius(radius),
  };
}

export function clampPitch(value: number): number {
  return Math.max(MIN_PITCH, Math.min(MAX_PITCH, value));
}

export function clampRadius(value: number): number {
  return Math.max(MIN_RADIUS, Math.min(MAX_RADIUS, value));
}
