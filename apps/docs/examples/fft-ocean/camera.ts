import { OCEAN_TUNING } from './tuning';

export interface OceanCamera { view: Float32Array<ArrayBuffer>; projection: Float32Array<ArrayBuffer> }
type Vec3 = readonly [number, number, number];

/** Exact fixed cinematic camera from front/fft-ocean-1. */
export function oceanCamera(size: readonly [number, number]): OceanCamera {
  const canonical = OCEAN_TUNING.camera;
  const base = lookAt(canonical.eye, canonical.target, canonical.up);
  const pitchRadians = canonical.pitchDegrees * Math.PI / 180;
  return {
    view: multiplyMat4(pitchViewRotation(pitchRadians), base),
    projection: perspective(canonical.fovDegrees * Math.PI / 180, size[0] / Math.max(1, size[1]), canonical.near, canonical.far),
  };
}

function lookAt(eye: Vec3, target: Vec3, up: Vec3): Float32Array<ArrayBuffer> {
  const z = normalize([eye[0] - target[0], eye[1] - target[1], eye[2] - target[2]]);
  const x = normalize(cross(up, z));
  const y = cross(z, x);
  return new Float32Array([
    x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0,
    -dot(x, eye), -dot(y, eye), -dot(z, eye), 1,
  ]) as Float32Array<ArrayBuffer>;
}

function perspective(fov: number, aspect: number, near: number, far: number): Float32Array<ArrayBuffer> {
  const f = 1 / Math.tan(fov / 2);
  return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, far / (near - far), -1, 0, 0, far * near / (near - far), 0]) as Float32Array<ArrayBuffer>;
}
function pitchViewRotation(radians: number): Float32Array<ArrayBuffer> {
  const c = Math.cos(radians), s = Math.sin(radians);
  return new Float32Array([1, 0, 0, 0, 0, c, -s, 0, 0, s, c, 0, 0, 0, 0, 1]) as Float32Array<ArrayBuffer>;
}
function multiplyMat4(a: Float32Array<ArrayBuffer>, b: Float32Array<ArrayBuffer>): Float32Array<ArrayBuffer> {
  const out = new Float32Array(16) as Float32Array<ArrayBuffer>;
  for (let col = 0; col < 4; col++) for (let row = 0; row < 4; row++) {
    out[col * 4 + row] = a[row]! * b[col * 4]! + a[4 + row]! * b[col * 4 + 1]! + a[8 + row]! * b[col * 4 + 2]! + a[12 + row]! * b[col * 4 + 3]!;
  }
  return out;
}
function normalize(v: Vec3): Vec3 { const l = Math.hypot(...v); return [v[0] / l, v[1] / l, v[2] / l]; }
function cross(a: Vec3, b: Vec3): Vec3 { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function dot(a: Vec3, b: Vec3): number { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
