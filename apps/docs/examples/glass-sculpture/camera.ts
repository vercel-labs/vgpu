export const DEFAULT_YAW = 0.9;
export const DEFAULT_PITCH = 0.28;
export const ORBIT_RADIUS = 3.6;
export const MIN_RADIUS = 1.6;
export const MAX_RADIUS = 6.5;
export const MIN_PITCH = -0.2;
export const MAX_PITCH = 1.15;

export interface CameraView {
  readonly yaw: number;
  readonly pitch: number;
  readonly radius: number;
}

export function cameraView(
  yaw: number,
  pitch: number,
  radius: number = ORBIT_RADIUS
): CameraView {
  return {
    yaw,
    pitch: clampPitch(pitch),
    radius: clampRadius(radius),
  };
}

export function clampPitch(pitch: number): number {
  return Math.max(MIN_PITCH, Math.min(MAX_PITCH, pitch));
}

export function clampRadius(radius: number): number {
  return Math.max(MIN_RADIUS, Math.min(MAX_RADIUS, radius));
}
