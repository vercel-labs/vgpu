import type { Mat4, Vec3 } from "./camera.ts";

/** Minimal camera-only matrix math, kept local so scene users do not load all of wgpu-matrix. */
export function viewProjection(projection: Mat4, eye: Vec3, target: Vec3, up: Vec3): Mat4 {
  const z = normalize(eye[0] - target[0], eye[1] - target[1], eye[2] - target[2]);
  const x = normalize(up[1] * z[2] - up[2] * z[1], up[2] * z[0] - up[0] * z[2], up[0] * z[1] - up[1] * z[0]);
  const y = normalize(z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]);
  const view = new Float32Array([
    x[0], y[0], z[0], 0,
    x[1], y[1], z[1], 0,
    x[2], y[2], z[2], 0,
    -(x[0] * eye[0] + x[1] * eye[1] + x[2] * eye[2]),
    -(y[0] * eye[0] + y[1] * eye[1] + y[2] * eye[2]),
    -(z[0] * eye[0] + z[1] * eye[1] + z[2] * eye[2]),
    1,
  ]);
  const result = new Float32Array(16);
  for (let column = 0; column < 4; column++) {
    const offset = column * 4;
    for (let row = 0; row < 4; row++) {
      result[offset + row] = projection[row]! * view[offset]! + projection[4 + row]! * view[offset + 1]! + projection[8 + row]! * view[offset + 2]! + projection[12 + row]! * view[offset + 3]!;
    }
  }
  return result;
}

export function perspective(fov: number, aspect: number, near: number, far: number): Mat4 {
  const f = Math.tan(Math.PI * 0.5 - 0.5 * fov);
  const range = 1 / (near - far);
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, Number.isFinite(far) ? far * range : -1, -1,
    0, 0, Number.isFinite(far) ? far * near * range : -near, 0,
  ]);
}

export function orthographic(left: number, right: number, bottom: number, top: number, near: number, far: number): Mat4 {
  return new Float32Array([
    2 / (right - left), 0, 0, 0,
    0, 2 / (top - bottom), 0, 0,
    0, 0, 1 / (near - far), 0,
    (right + left) / (left - right), (top + bottom) / (bottom - top), near / (near - far), 1,
  ]);
}

function normalize(x: number, y: number, z: number): Float32Array {
  const lengthSquared = x * x + y * y + z * z;
  const scale = lengthSquared > 0 ? 1 / Math.sqrt(lengthSquared) : 1;
  return new Float32Array([x * scale, y * scale, z * scale]);
}
