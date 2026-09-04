import { ATMOSPHERE_PHYSICS, CAMERA_TUNING, type AtmosphereState } from './tuning';

type Vec3 = readonly [number, number, number];

export type CameraUniformValues = {
  position: Vec3; tanHalfFov: number;
  forward: Vec3; aspect: number;
  right: Vec3; sunAngularRadius: number;
  up: Vec3; pixelAngle: number;
}

const DEG = Math.PI / 180;

/** Direction from elevation/azimuth angles in degrees; azimuth 0 points toward +Z. */
export function directionFromAngles(elevationDeg: number, azimuthDeg: number): Vec3 {
  const elevation = elevationDeg * DEG;
  const azimuth = azimuthDeg * DEG;
  return [Math.cos(elevation) * Math.sin(azimuth), Math.sin(elevation), Math.cos(elevation) * Math.cos(azimuth)];
}

export function sunDirection(state: AtmosphereState): Vec3 {
  return directionFromAngles(state.sunElevation, state.sunAzimuth);
}

/** Planet-centric camera basis: the camera sits on the +Y axis at ground radius + altitude. */
export function cameraUniforms(state: AtmosphereState, size: readonly [number, number]): CameraUniformValues {
  const altitude = Math.min(Math.max(state.altitudeKm, 0.001), CAMERA_TUNING.maxAltitudeKm);
  const forward = directionFromAngles(state.pitch, state.yaw);
  const right = normalize(cross([0, 1, 0], forward));
  const up = cross(forward, right);
  const tanHalfFov = Math.tan(CAMERA_TUNING.fovDegrees * DEG / 2);
  return {
    position: [0, ATMOSPHERE_PHYSICS.groundRadius + altitude, 0], tanHalfFov,
    forward, aspect: size[0] / Math.max(1, size[1]),
    right, sunAngularRadius: ATMOSPHERE_PHYSICS.sunAngularRadius,
    up, pixelAngle: 2 * tanHalfFov / Math.max(1, size[1]),
  };
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function normalize(v: Vec3): Vec3 {
  const length = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / length, v[1] / length, v[2] / length];
}

export interface TerrainSector { readonly first: number; readonly count: number }

/** Below this elevation no ray can meet terrain: the peaks are 3.2 km high and start 6 km out. */
const TERRAIN_MAX_ELEVATION = 0.6;

/**
 * Columns of the terrain ring grid (terrain-mesh.wgsl) that can appear in the frustum: a contiguous azimuth range
 * starting at `first` and wrapping past the last column, every column when the frustum contains the nadir, none when
 * the whole frustum looks above any terrain. Azimuth 0 is +Z, like `directionFromAngles`.
 */
export function terrainSector(camera: CameraUniformValues, columns: number): TerrainSector {
  const halfWidth = camera.tanHalfFov * camera.aspect;
  const halfHeight = camera.tanHalfFov;
  // The nadir projected on the image plane: inside the frustum means the ground wraps all the way around.
  const nadirDepth = -camera.forward[1];
  if (nadirDepth > 0 && Math.abs(-camera.right[1] / nadirDepth) <= halfWidth && Math.abs(-camera.up[1] / nadirDepth) <= halfHeight) {
    return { first: 0, count: columns };
  }
  const center = Math.atan2(camera.forward[0], camera.forward[2]);
  let half = 0;
  let lowestElevation = Infinity;
  const samples = 16;
  for (let i = 0; i < samples; i++) {
    const t = -1 + (2 * i) / (samples - 1);
    for (const [x, y] of [[t, -1], [t, 1], [-1, t], [1, t]] as const) {
      const ray = [
        camera.forward[0] + camera.right[0] * x * halfWidth + camera.up[0] * y * halfHeight,
        camera.forward[1] + camera.right[1] * x * halfWidth + camera.up[1] * y * halfHeight,
        camera.forward[2] + camera.right[2] * x * halfWidth + camera.up[2] * y * halfHeight,
      ] as const;
      lowestElevation = Math.min(lowestElevation, Math.atan2(ray[1], Math.hypot(ray[0], ray[2])));
      half = Math.max(half, Math.abs(wrapAngle(Math.atan2(ray[0], ray[2]) - center)));
    }
  }
  if (lowestElevation > TERRAIN_MAX_ELEVATION) return { first: 0, count: 0 };
  const step = (2 * Math.PI) / columns;
  const margin = 2;
  const count = Math.min(columns, Math.ceil((2 * half) / step) + 2 * margin);
  const first = (((Math.floor((center - half) / step) - margin) % columns) + columns) % columns;
  return { first, count };
}

function wrapAngle(angle: number): number {
  return angle - 2 * Math.PI * Math.round(angle / (2 * Math.PI));
}
