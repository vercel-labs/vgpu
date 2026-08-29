// Device-free camera, sun, and sizing math for the Earth renderer.

type Vec3 = readonly [number, number, number];

export const EARTH_TUNING = {
  camera: {
    fov: 40,
    near: 0.1,
    far: 200,
    radius: 8,
    minRadius: 1.25,
    maxRadius: 24,
  },
  planet: { radius: 1, widthSegments: 256, heightSegments: 128 },
  atmosphere: {
    radius: 1.02,
    widthSegments: 128,
    heightSegments: 64,
    strength: 1,
  },
  maps: { size: [2048, 1024] as const },
  sun: { tiltDegrees: 13, degreesPerSecond: 4 },
  bloom: { height: 360, radii: [1.4, 3.4] as const },
  poster: { yaw: 0.62, pitch: 0.16, radius: 7.4, sunDegrees: 338 },
} as const;

export function sunDirection(degrees: number): Vec3 {
  const tilt = (EARTH_TUNING.sun.tiltDegrees * Math.PI) / 180;
  const angle = (degrees * Math.PI) / 180;
  const ring = Math.cos(tilt);
  return [ring * Math.cos(angle), Math.sin(tilt), ring * Math.sin(angle)];
}

export interface OrbitState {
  readonly yaw: number;
  readonly pitch: number;
  readonly radius: number;
}

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

// Rebuilds sky view rays without inverting the view-projection matrix.
export function cameraBasis(
  position: Vec3,
  target: Vec3,
  fovDegrees: number,
  up: Vec3 = [0, 1, 0]
) {
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

export function bloomSize(size: readonly [number, number]): [number, number] {
  const height = Math.max(1, Math.min(EARTH_TUNING.bloom.height, size[1]));
  return [Math.max(1, Math.round((height * size[0]) / size[1])), height];
}

export function normalizeSize(
  size: readonly [number, number]
): [number, number] {
  return [Math.max(1, Math.floor(size[0])), Math.max(1, Math.floor(size[1]))];
}

function subtract(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function negate(a: Vec3): Vec3 {
  return [-a[0], -a[1], -a[2]];
}
function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}
function normalize(a: Vec3): Vec3 {
  const length = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / length, a[1] / length, a[2] / length];
}
