import { VGPUError } from "../errors.ts";
import { isFiniteFloat32, readFiniteValues, sizeError, valueError } from "./validation.ts";

export type Mat4 = Float32Array;
export type Vec3Like = ArrayLike<number>;
export type QuatLike = ArrayLike<number>;

export interface TransformValues {
  position?: Vec3Like;
  /** Intrinsic XYZ Euler angles in radians. Ignored when `quaternion` is supplied. */
  rotation?: Vec3Like;
  quaternion?: QuatLike;
  scale?: number | Vec3Like;
}

export function composeMatrix(values: TransformValues, out: Mat4): Mat4 {
  assertMatrixLength(out, "composeMatrix", "out");
  const position = values.position === undefined
    ? [0, 0, 0]
    : readFiniteValues(values.position, 3, "composeMatrix", "position", "VGPU-SCENE-VALUE");

  let quaternion: number[];
  if (values.quaternion !== undefined) {
    quaternion = normalizeQuaternion(
      readFiniteValues(values.quaternion, 4, "composeMatrix", "quaternion", "VGPU-SCENE-VALUE"),
      "composeMatrix",
      "quaternion",
    );
  } else if (values.rotation !== undefined) {
    const rotation = readFiniteValues(values.rotation, 3, "composeMatrix", "rotation", "VGPU-SCENE-VALUE");
    quaternion = quaternionFromEuler(rotation[0]!, rotation[1]!, rotation[2]!);
  } else {
    quaternion = [0, 0, 0, 1];
  }

  let scale: number[];
  if (values.scale === undefined) {
    scale = [1, 1, 1];
  } else if (typeof values.scale === "number") {
    if (!Number.isFinite(values.scale)) {
      throw valueError(
        "VGPU-SCENE-VALUE",
        "composeMatrix",
        "scale",
        `${String(values.scale)} is not finite`,
        "Pass one finite scale or exactly three finite scale components.",
      );
    }
    scale = [values.scale, values.scale, values.scale];
  } else {
    scale = readFiniteValues(values.scale, 3, "composeMatrix", "scale", "VGPU-SCENE-VALUE");
  }

  const staged = composeUnchecked(position, quaternion, scale);
  commitFiniteMatrix(staged, out, "composeMatrix");
  return out;
}

export function multiplyMatrices(a: ArrayLike<number>, b: ArrayLike<number>, out: Mat4): Mat4 {
  assertMatrixLength(a, "multiplyMatrices", "a");
  assertMatrixLength(b, "multiplyMatrices", "b");
  assertMatrixLength(out, "multiplyMatrices", "out");
  const left = readFiniteMatrix(a, "multiplyMatrices", "a");
  const right = readFiniteMatrix(b, "multiplyMatrices", "b");
  const staged = multiplyUnchecked(left, right);
  commitFiniteMatrix(staged, out, "multiplyMatrices");
  return out;
}

export function invertAffine(matrix: ArrayLike<number>, out: Mat4): Mat4 {
  assertMatrixLength(matrix, "invertAffine", "matrix");
  assertMatrixLength(out, "invertAffine", "out");
  const input = readFiniteMatrix(matrix, "invertAffine", "matrix");
  assertAffine(input, "invertAffine", "matrix");
  const staged = invertAffineUnchecked(input, "invertAffine");
  commitFiniteMatrix(staged, out, "invertAffine", singularError("invertAffine"));
  return out;
}

export function localFromWorld(parentWorld: ArrayLike<number>, world: ArrayLike<number>, out: Mat4): Mat4 {
  assertMatrixLength(parentWorld, "localFromWorld", "parentWorld");
  assertMatrixLength(world, "localFromWorld", "world");
  assertMatrixLength(out, "localFromWorld", "out");
  const parent = readFiniteMatrix(parentWorld, "localFromWorld", "parentWorld");
  const child = readFiniteMatrix(world, "localFromWorld", "world");
  assertAffine(parent, "localFromWorld", "parentWorld");
  assertAffine(child, "localFromWorld", "world");
  const inverse = invertAffineUnchecked(parent, "localFromWorld");
  assertFiniteMatrix(inverse, "localFromWorld", singularError("localFromWorld"));
  const staged = multiplyUnchecked(inverse, child);
  commitFiniteMatrix(staged, out, "localFromWorld");
  return out;
}

function assertMatrixLength(value: ArrayLike<number>, operation: string, field: string): void {
  if (value.length !== 16) throw sizeError(operation, field, value.length, 16);
}

function readFiniteMatrix(value: ArrayLike<number>, operation: string, field: string): number[] {
  return readFiniteValues(value, 16, operation, field, "VGPU-SCENE-VALUE");
}

function normalizeQuaternion(value: readonly number[], operation: string, field: string): number[] {
  const length = Math.hypot(value[0]!, value[1]!, value[2]!, value[3]!);
  if (length === 0 || !Number.isFinite(length)) {
    throw valueError(
      "VGPU-SCENE-VALUE",
      operation,
      field,
      "the quaternion has zero or non-finite length",
      "Pass a finite, nonzero XYZW quaternion.",
    );
  }
  return [value[0]! / length, value[1]! / length, value[2]! / length, value[3]! / length];
}

function quaternionFromEuler(x: number, y: number, z: number): number[] {
  const c1 = Math.cos(x / 2), s1 = Math.sin(x / 2);
  const c2 = Math.cos(y / 2), s2 = Math.sin(y / 2);
  const c3 = Math.cos(z / 2), s3 = Math.sin(z / 2);
  return [
    s1 * c2 * c3 + c1 * s2 * s3,
    c1 * s2 * c3 - s1 * c2 * s3,
    c1 * c2 * s3 + s1 * s2 * c3,
    c1 * c2 * c3 - s1 * s2 * s3,
  ];
}

function composeUnchecked(position: readonly number[], quaternion: readonly number[], scale: readonly number[]): number[] {
  const x = quaternion[0]!, y = quaternion[1]!, z = quaternion[2]!, w = quaternion[3]!;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  const sx = scale[0]!, sy = scale[1]!, sz = scale[2]!;
  return [
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    position[0]!, position[1]!, position[2]!, 1,
  ];
}

function multiplyUnchecked(a: readonly number[], b: readonly number[]): number[] {
  const result = new Array<number>(16);
  for (let column = 0; column < 4; column++) {
    const offset = column * 4;
    const b0 = b[offset]!, b1 = b[offset + 1]!, b2 = b[offset + 2]!, b3 = b[offset + 3]!;
    result[offset] = a[0]! * b0 + a[4]! * b1 + a[8]! * b2 + a[12]! * b3;
    result[offset + 1] = a[1]! * b0 + a[5]! * b1 + a[9]! * b2 + a[13]! * b3;
    result[offset + 2] = a[2]! * b0 + a[6]! * b1 + a[10]! * b2 + a[14]! * b3;
    result[offset + 3] = a[3]! * b0 + a[7]! * b1 + a[11]! * b2 + a[15]! * b3;
  }
  return result;
}

function invertAffineUnchecked(matrix: readonly number[], operation: string): number[] {
  const a00 = matrix[0]!, a01 = matrix[1]!, a02 = matrix[2]!;
  const a10 = matrix[4]!, a11 = matrix[5]!, a12 = matrix[6]!;
  const a20 = matrix[8]!, a21 = matrix[9]!, a22 = matrix[10]!;
  const b00 = a11 * a22 - a12 * a21;
  const b01 = a12 * a20 - a10 * a22;
  const b02 = a10 * a21 - a11 * a20;
  const determinant = a00 * b00 + a01 * b01 + a02 * b02;
  if (determinant === 0 || !Number.isFinite(determinant)) throw singularError(operation);

  const inverseDeterminant = 1 / determinant;
  const i00 = b00 * inverseDeterminant;
  const i10 = b01 * inverseDeterminant;
  const i20 = b02 * inverseDeterminant;
  const i01 = (a02 * a21 - a01 * a22) * inverseDeterminant;
  const i11 = (a00 * a22 - a02 * a20) * inverseDeterminant;
  const i21 = (a01 * a20 - a00 * a21) * inverseDeterminant;
  const i02 = (a01 * a12 - a02 * a11) * inverseDeterminant;
  const i12 = (a02 * a10 - a00 * a12) * inverseDeterminant;
  const i22 = (a00 * a11 - a01 * a10) * inverseDeterminant;
  const tx = matrix[12]!, ty = matrix[13]!, tz = matrix[14]!;
  return [
    i00, i01, i02, 0,
    i10, i11, i12, 0,
    i20, i21, i22, 0,
    -(i00 * tx + i10 * ty + i20 * tz),
    -(i01 * tx + i11 * ty + i21 * tz),
    -(i02 * tx + i12 * ty + i22 * tz),
    1,
  ];
}

function assertAffine(matrix: readonly number[], operation: string, field: string): void {
  if (matrix[3] !== 0 || matrix[7] !== 0 || matrix[11] !== 0 || matrix[15] !== 1) {
    throw valueError(
      "VGPU-SCENE-VALUE",
      operation,
      field,
      "the matrix is not affine (indices 3, 7, 11, 15 must be 0, 0, 0, 1)",
      "Pass a finite affine matrix with an exact [0, 0, 0, 1] bottom row.",
    );
  }
}

function commitFiniteMatrix(staged: readonly number[], out: Mat4, operation: string, error?: VGPUError): void {
  assertFiniteMatrix(staged, operation, error);
  for (let index = 0; index < 16; index++) out[index] = staged[index]!;
}

function assertFiniteMatrix(staged: readonly number[], operation: string, error?: VGPUError): void {
  for (let index = 0; index < 16; index++) {
    if (!isFiniteFloat32(staged[index]!)) {
      throw error ?? valueError(
        "VGPU-SCENE-VALUE",
        operation,
        `result[${index}]`,
        "the result is not representable as finite float32",
        "Use finite inputs whose composed or multiplied result fits in float32.",
      );
    }
  }
}

function singularError(operation: string): VGPUError {
  return new VGPUError({
    code: "VGPU-SPATIAL-SINGULAR",
    message: `${operation} cannot invert a matrix with a zero or non-finite determinant, or an inverse outside finite float32 range.`,
    fix: "Restore an invertible finite affine matrix and use scales whose inverse is representable as finite float32; the output was left unchanged.",
    where: operation,
  });
}
