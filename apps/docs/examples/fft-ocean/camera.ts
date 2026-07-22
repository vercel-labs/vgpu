export interface OceanCamera { view: Float32Array<ArrayBuffer>; projection: Float32Array<ArrayBuffer> }

type Vec3 = readonly [number, number, number];

export function oceanCamera(size: readonly [number, number], orbit: readonly [number, number]): OceanCamera {
  const [yaw, pitch] = orbit;
  const target: Vec3 = [Math.sin(yaw) * 22, 4 + pitch * 22, -40 + (1 - Math.cos(yaw)) * 14];
  const eye: Vec3 = [Math.sin(yaw) * 18, 19.3 + pitch * 18, 60];
  return {
    view: lookAt(eye, target, [0, 1, 0]),
    projection: perspective(Math.PI / 3, size[0] / Math.max(1, size[1]), 0.1, 2000),
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
function normalize(v: Vec3): Vec3 { const l = Math.hypot(...v); return [v[0] / l, v[1] / l, v[2] / l]; }
function cross(a: Vec3, b: Vec3): Vec3 { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function dot(a: Vec3, b: Vec3): number { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
