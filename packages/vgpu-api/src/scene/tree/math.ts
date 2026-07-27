// Minimal column-major mat4/quat math for the scene tree. Kept local (same policy as
// geometry-src/camera-math.ts) so vgpu/scene stays inside its bundle budget instead of
// pulling the wgpu-matrix runtime.

export type Mat4 = Float32Array;

export function identityMat4(out: Mat4): Mat4 {
  out.fill(0);
  out[0] = out[5] = out[10] = out[15] = 1;
  return out;
}

export function copyMat4(out: Mat4, m: Mat4): Mat4 {
  out.set(m);
  return out;
}

/** out = position/quaternion/scale composed into a column-major TRS matrix. */
export function composeTrs(out: Mat4, position: Float32Array, quaternion: Float32Array, scale: Float32Array): Mat4 {
  const x = quaternion[0]!, y = quaternion[1]!, z = quaternion[2]!, w = quaternion[3]!;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  const sx = scale[0]!, sy = scale[1]!, sz = scale[2]!;
  out[0] = (1 - (yy + zz)) * sx; out[1] = (xy + wz) * sx; out[2] = (xz - wy) * sx; out[3] = 0;
  out[4] = (xy - wz) * sy; out[5] = (1 - (xx + zz)) * sy; out[6] = (yz + wx) * sy; out[7] = 0;
  out[8] = (xz + wy) * sz; out[9] = (yz - wx) * sz; out[10] = (1 - (xx + yy)) * sz; out[11] = 0;
  out[12] = position[0]!; out[13] = position[1]!; out[14] = position[2]!; out[15] = 1;
  return out;
}

/** out = a * b. Safe when out aliases a or b. */
export function multiplyMat4(out: Mat4, a: Mat4, b: Mat4): Mat4 {
  const a00 = a[0]!, a01 = a[1]!, a02 = a[2]!, a03 = a[3]!;
  const a10 = a[4]!, a11 = a[5]!, a12 = a[6]!, a13 = a[7]!;
  const a20 = a[8]!, a21 = a[9]!, a22 = a[10]!, a23 = a[11]!;
  const a30 = a[12]!, a31 = a[13]!, a32 = a[14]!, a33 = a[15]!;
  for (let column = 0; column < 4; column++) {
    const offset = column * 4;
    const b0 = b[offset]!, b1 = b[offset + 1]!, b2 = b[offset + 2]!, b3 = b[offset + 3]!;
    out[offset] = a00 * b0 + a10 * b1 + a20 * b2 + a30 * b3;
    out[offset + 1] = a01 * b0 + a11 * b1 + a21 * b2 + a31 * b3;
    out[offset + 2] = a02 * b0 + a12 * b1 + a22 * b2 + a32 * b3;
    out[offset + 3] = a03 * b0 + a13 * b1 + a23 * b2 + a33 * b3;
  }
  return out;
}

/** Inverts an affine TRS matrix (last row assumed 0,0,0,1). */
export function invertAffineMat4(out: Mat4, m: Mat4): Mat4 {
  const a00 = m[0]!, a01 = m[1]!, a02 = m[2]!;
  const a10 = m[4]!, a11 = m[5]!, a12 = m[6]!;
  const a20 = m[8]!, a21 = m[9]!, a22 = m[10]!;
  const tx = m[12]!, ty = m[13]!, tz = m[14]!;
  const b00 = a11 * a22 - a12 * a21;
  const b01 = a12 * a20 - a10 * a22;
  const b02 = a10 * a21 - a11 * a20;
  const det = a00 * b00 + a01 * b01 + a02 * b02;
  const invDet = det === 0 ? 0 : 1 / det;
  const i00 = b00 * invDet, i10 = b01 * invDet, i20 = b02 * invDet;
  const i01 = (a02 * a21 - a01 * a22) * invDet;
  const i11 = (a00 * a22 - a02 * a20) * invDet;
  const i21 = (a01 * a20 - a00 * a21) * invDet;
  const i02 = (a01 * a12 - a02 * a11) * invDet;
  const i12 = (a02 * a10 - a00 * a12) * invDet;
  const i22 = (a00 * a11 - a01 * a10) * invDet;
  out[0] = i00; out[1] = i01; out[2] = i02; out[3] = 0;
  out[4] = i10; out[5] = i11; out[6] = i12; out[7] = 0;
  out[8] = i20; out[9] = i21; out[10] = i22; out[11] = 0;
  out[12] = -(i00 * tx + i10 * ty + i20 * tz);
  out[13] = -(i01 * tx + i11 * ty + i21 * tz);
  out[14] = -(i02 * tx + i12 * ty + i22 * tz);
  out[15] = 1;
  return out;
}

/** out = m * [p, 1]; returns the transformed point. */
export function transformPoint(out: Float32Array, m: Mat4, p: Float32Array): Float32Array {
  const x = p[0]!, y = p[1]!, z = p[2]!;
  out[0] = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!;
  out[1] = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!;
  out[2] = m[2]! * x + m[6]! * y + m[10]! * z + m[14]!;
  return out;
}

/** out = the linear part of m applied to a direction (no translation). */
export function transformDirection(out: Float32Array, m: Mat4, v: Float32Array): Float32Array {
  const x = v[0]!, y = v[1]!, z = v[2]!;
  out[0] = m[0]! * x + m[4]! * y + m[8]! * z;
  out[1] = m[1]! * x + m[5]! * y + m[9]! * z;
  out[2] = m[2]! * x + m[6]! * y + m[10]! * z;
  return out;
}

/** Intrinsic XYZ Euler angles (radians) to quaternion. */
export function quatFromEuler(out: Float32Array, x: number, y: number, z: number): Float32Array {
  const c1 = Math.cos(x / 2), s1 = Math.sin(x / 2);
  const c2 = Math.cos(y / 2), s2 = Math.sin(y / 2);
  const c3 = Math.cos(z / 2), s3 = Math.sin(z / 2);
  out[0] = s1 * c2 * c3 + c1 * s2 * s3;
  out[1] = c1 * s2 * c3 - s1 * c2 * s3;
  out[2] = c1 * c2 * s3 + s1 * s2 * c3;
  out[3] = c1 * c2 * c3 - s1 * s2 * s3;
  return out;
}

/** out = a * b (quaternion product). Safe when out aliases a or b. */
export function multiplyQuat(out: Float32Array, a: Float32Array, b: Float32Array): Float32Array {
  const ax = a[0]!, ay = a[1]!, az = a[2]!, aw = a[3]!;
  const bx = b[0]!, by = b[1]!, bz = b[2]!, bw = b[3]!;
  out[0] = ax * bw + aw * bx + ay * bz - az * by;
  out[1] = ay * bw + aw * by + az * bx - ax * bz;
  out[2] = az * bw + aw * bz + ax * by - ay * bx;
  out[3] = aw * bw - ax * bx - ay * by - az * bz;
  return out;
}

/** Conjugate of a unit quaternion (its inverse). */
export function conjugateQuat(out: Float32Array, q: Float32Array): Float32Array {
  out[0] = -q[0]!; out[1] = -q[1]!; out[2] = -q[2]!; out[3] = q[3]!;
  return out;
}

/** Quaternion from three orthonormal basis columns (rotation part of a matrix). */
export function quatFromBasis(
  out: Float32Array,
  m00: number, m01: number, m02: number,
  m10: number, m11: number, m12: number,
  m20: number, m21: number, m22: number,
): Float32Array {
  // Arguments are the basis COLUMNS of a column-major rotation matrix: mij is component j
  // of basis vector i, i.e. matrix row j+1, column i+1.
  const trace = m00 + m11 + m22;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    out[3] = 0.25 / s;
    out[0] = (m12 - m21) * s;
    out[1] = (m20 - m02) * s;
    out[2] = (m01 - m10) * s;
  } else if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    out[3] = (m12 - m21) / s;
    out[0] = 0.25 * s;
    out[1] = (m10 + m01) / s;
    out[2] = (m20 + m02) / s;
  } else if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    out[3] = (m20 - m02) / s;
    out[0] = (m10 + m01) / s;
    out[1] = 0.25 * s;
    out[2] = (m21 + m12) / s;
  } else {
    const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
    out[3] = (m01 - m10) / s;
    out[0] = (m20 + m02) / s;
    out[1] = (m21 + m12) / s;
    out[2] = 0.25 * s;
  }
  return out;
}

/** Rotation that makes -Z point from eye toward target (camera/look convention). */
export function quatLookAt(out: Float32Array, eye: Float32Array, target: Float32Array, up: Float32Array): Float32Array {
  let zx = eye[0]! - target[0]!, zy = eye[1]! - target[1]!, zz = eye[2]! - target[2]!;
  const zLen = Math.hypot(zx, zy, zz);
  if (zLen === 0) {
    out[0] = 0; out[1] = 0; out[2] = 0; out[3] = 1;
    return out;
  }
  zx /= zLen; zy /= zLen; zz /= zLen;
  let xx = up[1]! * zz - up[2]! * zy;
  let xy = up[2]! * zx - up[0]! * zz;
  let xz = up[0]! * zy - up[1]! * zx;
  let xLen = Math.hypot(xx, xy, xz);
  if (xLen === 0) {
    // up is parallel to the view direction; pick a stable orthogonal axis.
    xx = zz; xy = 0; xz = -zx;
    xLen = Math.hypot(xx, xy, xz);
    if (xLen === 0) { xx = 1; xy = 0; xz = 0; xLen = 1; }
  }
  xx /= xLen; xy /= xLen; xz /= xLen;
  const yx = zy * xz - zz * xy;
  const yy = zz * xx - zx * xz;
  const yz = zx * xy - zy * xx;
  return quatFromBasis(out, xx, xy, xz, yx, yy, yz, zx, zy, zz);
}

/** Quaternion from the rotation part of an affine matrix, ignoring (positive) scale. */
export function quatFromMat4Rotation(out: Float32Array, m: Mat4): Float32Array {
  const sx = Math.hypot(m[0]!, m[1]!, m[2]!) || 1;
  const sy = Math.hypot(m[4]!, m[5]!, m[6]!) || 1;
  const sz = Math.hypot(m[8]!, m[9]!, m[10]!) || 1;
  return quatFromBasis(
    out,
    m[0]! / sx, m[1]! / sx, m[2]! / sx,
    m[4]! / sy, m[5]! / sy, m[6]! / sy,
    m[8]! / sz, m[9]! / sz, m[10]! / sz,
  );
}
