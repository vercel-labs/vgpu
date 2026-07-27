// Scene-level constants and the small amount of camera/sun math the shaders need.
// Kept out of `example.ts` so the render graph there reads as pure vgpu calls, and
// so the geometry can be unit tested without a device (see `planet.test.ts`).

export type Vec3 = readonly [number, number, number];

export const EARTH_TUNING = {
  /** Default camera framing for the planet. */
  camera: { fov: 40, near: 0.1, far: 200, radius: 8, minRadius: 1.25, maxRadius: 24 },
  /** Planet radius 1 with a 2% larger atmosphere shell. */
  planet: { radius: 1, widthSegments: 256, heightSegments: 128 },
  atmosphere: { radius: 1.02, widthSegments: 128, heightSegments: 64, strength: 1 },
  /** Baked equirectangular maps. 2048x1024 holds up when the live camera zooms in. */
  maps: { size: [2048, 1024] as const },
  /** The sun starts 13 degrees above the equatorial plane and orbits around Y. */
  sun: { tiltDegrees: 13, degreesPerSecond: 4, intensity: 12 },
  bloom: { height: 360, threshold: 0.71, knee: 0.35, strength: 1.8, radii: [1.4, 3.4] as const },
  grade: { exposure: 1.05, vignetteStart: 0.5, vignetteDarkness: 0.45, grain: 0.018, starBrightness: 1 },
  /** Deterministic framing used by the docs thumbnail renderer. */
  poster: { yaw: 0.62, pitch: 0.16, radius: 7.4, sunDegrees: 338 },
} as const;

/** Sun direction for a rotation in degrees. */
export function sunDirection(degrees: number): Vec3 {
  const tilt = (EARTH_TUNING.sun.tiltDegrees * Math.PI) / 180;
  const angle = (degrees * Math.PI) / 180;
  const ring = Math.cos(tilt);
  return [ring * Math.cos(angle), Math.sin(tilt), ring * Math.sin(angle)];
}

/** Sun rotation at a given wall time; `renderThumb` uses it to pin a deterministic sun. */
export function sunDegreesAt(time: number): number {
  return time * EARTH_TUNING.sun.degreesPerSecond;
}

export interface OrbitState {
  readonly yaw: number;
  readonly pitch: number;
  readonly radius: number;
}

/** Camera eye position for an orbit state, clamped away from the poles. */
export function orbitPosition(state: OrbitState): Vec3 {
  const limit = Math.PI * 0.49;
  const pitch = Math.max(-limit, Math.min(limit, state.pitch));
  const cosPitch = Math.cos(pitch);
  return [
    state.radius * cosPitch * Math.sin(state.yaw),
    state.radius * Math.sin(pitch),
    state.radius * cosPitch * Math.cos(state.yaw),
  ];
}

export interface CameraBasis {
  /** Screen-right axis in world space. */
  readonly right: Vec3;
  /** Screen-up axis in world space. */
  readonly up: Vec3;
  /** View direction in world space. */
  readonly forward: Vec3;
  readonly tanHalfFov: number;
}

/**
 * Orthonormal basis matching `perspectiveCamera()` from `vgpu/scene`, so the sky
 * pass can build view rays from NDC without inverting the view-projection matrix.
 * Derivation is the same as the scene package's `viewProjection`: `z` points back
 * along the view, `x = up x z`, `y = z x x`.
 */
export function cameraBasis(position: Vec3, target: Vec3, fovDegrees: number, up: Vec3 = [0, 1, 0]): CameraBasis {
  const back = normalize(subtract(position, target));
  const right = normalize(cross(up, back));
  const screenUp = cross(back, right);
  return {
    right,
    up: screenUp,
    forward: negate(back),
    tanHalfFov: Math.tan(((fovDegrees * Math.PI) / 180) * 0.5),
  };
}

/** Bloom chain resolution for an output size, keeping the aspect ratio. */
export function bloomSize(size: readonly [number, number]): [number, number] {
  const height = Math.max(1, Math.min(EARTH_TUNING.bloom.height, size[1]));
  return [Math.max(1, Math.round((height * size[0]) / size[1])), height];
}

export function normalizeSize(size: readonly [number, number]): [number, number] {
  return [Math.max(1, Math.floor(size[0])), Math.max(1, Math.floor(size[1]))];
}

function subtract(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function negate(a: Vec3): Vec3 {
  return [-a[0], -a[1], -a[2]];
}
function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function normalize(a: Vec3): Vec3 {
  const length = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / length, a[1] / length, a[2] / length];
}
