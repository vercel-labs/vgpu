import type { HostShareableLayout, LayoutMember, WGSLType } from "@vgpu/wgsl/reflect-source";
import { setValueInvalidError, unsupportedError } from "./errors.ts";

/** Packs JS values into the frozen ReflectionFacade host-shareable layout bytes. */
export function writeLayoutValue(layout: HostShareableLayout, value: unknown): ArrayBuffer {
  ensureStaticLayoutSize(layout);
  validateValue(layout, value, "$", 0, layout.size);
  const bytes = new ArrayBuffer(layout.size);
  writeValue(new DataView(bytes), layout, 0, value);
  return bytes;
}

function ensureStaticLayoutSize(layout: HostShareableLayout): asserts layout is HostShareableLayout & { readonly size: number } {
  if (layout.size === undefined) throw unsupportedError("set", `No se puede inferir byteLength para layout runtime-sized '${layout.name}'.`);
}

function writeValue(view: DataView, layout: HostShareableLayout, offset: number, value: unknown): void {
  if (layout.members) return writeStruct(view, layout.members, offset, value);
  writeLeafValue(view, layout, offset, value);
}

function writeStruct(view: DataView, members: readonly LayoutMember[], base: number, value: unknown): void {
  const object = value as Record<string, unknown>;
  for (const member of members) writeValue(view, member.layout, base + member.offset, object?.[member.name]);
}

function writeLeafValue(view: DataView, layout: HostShareableLayout, offset: number, value: unknown): void {
  switch (layout.type.kind) {
    case "scalar": return writeScalar(view, offset, layout.type.name, value);
    case "atomic": return writeAtomic(view, offset, layout.type, value);
    case "vector": return writeVector(view, offset, layout.type, value);
    case "matrix": return writeMatrix(view, layout, offset, value);
    case "array": return writeArray(view, layout, offset, value);
    default: throw unsupportedError("set", `No hay writer para layout ${layout.type.kind}.`);
  }
}

function writeScalar(view: DataView, offset: number, type: "f32" | "f16" | "i32" | "u32" | "bool", value: unknown): void {
  if (type === "f32") view.setFloat32(offset, value as number, true);
  else if (type === "i32") view.setInt32(offset, value as number, true);
  else if (type === "u32" || type === "bool") view.setUint32(offset, type === "bool" ? (value ? 1 : 0) : value as number, true);
  else view.setUint16(offset, float32ToFloat16(value as number), true);
}

function writeAtomic(view: DataView, offset: number, type: Extract<WGSLType, { kind: "atomic" }>, value: unknown): void {
  writeScalar(view, offset, scalarName(type.element), value);
}

function writeVector(view: DataView, offset: number, type: Extract<WGSLType, { kind: "vector" }>, value: unknown): void {
  const values = value as ArrayLike<number>;
  const stride = scalarByteSize(type.element);
  for (let i = 0; i < type.width; i++) writeScalar(view, offset + i * stride, scalarName(type.element), values?.[i] ?? 0);
}

function writeMatrix(view: DataView, layout: HostShareableLayout, offset: number, value: unknown): void {
  const matrix = layout.type as Extract<WGSLType, { kind: "matrix" }>;
  const values = value as ArrayLike<number>;
  const scalar = scalarByteSize(matrix.element);
  const stride = layout.stride ?? 16;
  for (let c = 0; c < matrix.columns; c++) for (let r = 0; r < matrix.rows; r++) writeScalar(view, offset + c * stride + r * scalar, scalarName(matrix.element), values?.[c * matrix.rows + r] ?? 0);
}

function writeArray(view: DataView, layout: HostShareableLayout, offset: number, value: unknown): void {
  const values = value as ArrayLike<unknown>;
  const stride = layout.stride ?? layout.element?.size ?? 0;
  if (!layout.element) throw unsupportedError("set", "Array layout sin element layout.");
  for (let i = 0; i < values.length; i++) writeValue(view, layout.element, offset + i * stride, values[i]);
}

function validateValue(layout: HostShareableLayout, value: unknown, path: string, offset: number, byteLength: number): void {
  if (layout.members) {
    validateStruct(layout.members, value, path, offset, byteLength);
    return;
  }
  switch (layout.type.kind) {
    case "scalar":
      validateScalar(layout.type.name, value, path);
      validateRange(path, offset, scalarByteSize(layout.type), byteLength);
      return;
    case "atomic":
      validateScalar(scalarName(layout.type.element), value, path);
      validateRange(path, offset, 4, byteLength);
      return;
    case "vector":
      validateVector(layout.type, value, path, offset, byteLength);
      return;
    case "matrix":
      validateMatrix(layout, value, path, offset, byteLength);
      return;
    case "array":
      validateArray(layout, value, path, offset, byteLength);
      return;
    default:
      throw unsupportedError("set", `No hay validator para layout ${layout.type.kind}.`);
  }
}

function validateStruct(members: readonly LayoutMember[], value: unknown, path: string, base: number, byteLength: number): void {
  if (!isPlainRecord(value)) throwPacking("type", path, "an object", valueKind(value));
  const declared = new Set(members.map((member) => member.name));
  const unknown = Object.keys(value).find((name) => !declared.has(name));
  if (unknown !== undefined) throwPacking("unknown-field", `${path}.${unknown}`, "a declared field", unknown);
  for (const member of members) {
    const memberPath = `${path}.${member.name}`;
    if (!Object.hasOwn(value, member.name)) throwPacking("missing-field", memberPath, "a required field", "missing");
    validateValue(member.layout, value[member.name], memberPath, base + member.offset, byteLength);
  }
}

function validateVector(type: Extract<WGSLType, { kind: "vector" }>, value: unknown, path: string, offset: number, byteLength: number): void {
  const values = exactArrayLike(value, path, type.width);
  const scalar = scalarName(type.element);
  const stride = scalarByteSize(type.element);
  for (let index = 0; index < type.width; index++) {
    validateScalar(scalar, values[index], `${path}[${index}]`);
    validateRange(`${path}[${index}]`, offset + index * stride, stride, byteLength);
  }
}

function validateMatrix(layout: HostShareableLayout, value: unknown, path: string, offset: number, byteLength: number): void {
  const matrix = layout.type as Extract<WGSLType, { kind: "matrix" }>;
  const expected = matrix.columns * matrix.rows;
  const values = exactArrayLike(value, path, expected);
  const scalar = scalarName(matrix.element);
  const scalarSize = scalarByteSize(matrix.element);
  const stride = layout.stride;
  if (stride === undefined) throw unsupportedError("set", `Matrix layout '${layout.name}' sin stride.`);
  for (let column = 0; column < matrix.columns; column++) {
    for (let row = 0; row < matrix.rows; row++) {
      const index = column * matrix.rows + row;
      const elementPath = `${path}[${column}][${row}]`;
      validateScalar(scalar, values[index], elementPath);
      validateRange(elementPath, offset + column * stride + row * scalarSize, scalarSize, byteLength);
    }
  }
}

function validateArray(layout: HostShareableLayout, value: unknown, path: string, offset: number, byteLength: number): void {
  const values = arrayLike(value, path);
  const arrayType = layout.type as Extract<WGSLType, { kind: "array" }>;
  if (arrayType.count !== undefined && values.length !== arrayType.count) {
    throwPacking("shape", path, arrayType.count, values.length);
  }
  const stride = layout.stride;
  if (stride === undefined || !layout.element) throw unsupportedError("set", `Array layout '${layout.name}' sin stride o element layout.`);
  if (layout.runtimeSized) {
    const expected = checkedExtent(stride, values.length, path);
    const actual = layout.size ?? byteLength - offset;
    if (actual !== expected) throwPacking("extent", path, expected, actual);
  }
  for (let index = 0; index < values.length; index++) {
    validateValue(layout.element, values[index], `${path}[${index}]`, offset + index * stride, byteLength);
  }
}

function validateScalar(type: "f32" | "f16" | "i32" | "u32" | "bool", value: unknown, path: string): void {
  if (type === "bool") {
    if (typeof value !== "boolean") throwPacking("type", path, "bool", valueKind(value), type);
    return;
  }
  if (typeof value !== "number") throwPacking("type", path, type, valueKind(value), type);
  if (type === "i32" && (!Number.isInteger(value) || value < -0x80000000 || value > 0x7fffffff)) {
    throwPacking("integer-range", path, "an integer in [-2147483648, 2147483647]", String(value), type);
  }
  if (type === "u32" && (!Number.isInteger(value) || value < 0 || value > 0xffffffff)) {
    throwPacking("integer-range", path, "an integer in [0, 4294967295]", String(value), type);
  }
}

function exactArrayLike(value: unknown, path: string, expected: number): ArrayLike<unknown> {
  const values = arrayLike(value, path);
  if (values.length !== expected) throwPacking("shape", path, expected, values.length);
  return values;
}

function arrayLike(value: unknown, path: string): ArrayLike<unknown> {
  if (Array.isArray(value)) return value;
  if (ArrayBuffer.isView(value) && !(value instanceof DataView) && "length" in value) {
    return value as unknown as ArrayLike<unknown>;
  }
  throwPacking("type", path, "an array or typed array", valueKind(value));
}

function validateRange(path: string, offset: number, size: number, byteLength: number): void {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || offset < 0 || size < 0 || offset > byteLength - size) {
    throwPacking("buffer-range", path, `${size} bytes inside ${byteLength}`, offset);
  }
}

function checkedExtent(stride: number, count: number, path: string): number {
  const extent = stride * count;
  if (!Number.isSafeInteger(stride) || stride < 0 || !Number.isSafeInteger(extent)) {
    throwPacking("extent", path, "a safe byte extent", String(extent));
  }
  return extent;
}

function throwPacking(reason: string, path: string, expected: string | number, actual: string | number, type?: string): never {
  const message = reason === "shape"
    ? `expected exactly ${expected} values, received ${actual}`
    : reason === "missing-field"
      ? "required field is missing"
      : reason === "unknown-field"
        ? `field '${actual}' is not declared by the layout`
        : reason === "integer-range"
          ? `${actual} is outside the exact ${type} range`
          : reason === "extent"
            ? `runtime extent requires ${expected} bytes, received ${actual}`
            : reason === "buffer-range"
              ? `write at byte ${actual} exceeds ${expected}`
              : `expected ${expected}, received ${actual}`;
  const detail = type === undefined
    ? { reason, path, expected, actual }
    : { reason, path, expected, actual, type };
  throw setValueInvalidError(detail, message);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value) || ArrayBuffer.isView(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function valueKind(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (ArrayBuffer.isView(value)) return value.constructor.name;
  return typeof value;
}

function scalarByteSize(type: WGSLType): number { return scalarName(type) === "f16" ? 2 : 4; }
function scalarName(type: WGSLType): "f32" | "f16" | "i32" | "u32" | "bool" { if (type.kind !== "scalar") throw unsupportedError("set", `Expected scalar, got ${type.kind}`); return type.name; }
function float32ToFloat16(value: number): number {
  const float = new Float32Array(1), int = new Uint32Array(float.buffer); float[0] = value; const x = int[0]!;
  const sign = (x >> 16) & 0x8000, mantissa = x & 0x007fffff, exponent = (x >> 23) & 0xff;
  if (exponent === 0xff) return sign | (mantissa ? 0x7e00 : 0x7c00);
  const halfExponent = exponent - 127 + 15;
  if (halfExponent >= 0x1f) return sign | 0x7c00;
  if (halfExponent <= 0) {
    if (halfExponent < -10) return sign;
    return sign | roundRightToNearestEven(mantissa | 0x00800000, 14 - halfExponent);
  }
  const roundedMantissa = roundRightToNearestEven(mantissa, 13);
  if (roundedMantissa === 0x0400) {
    const roundedExponent = halfExponent + 1;
    return roundedExponent >= 0x1f ? sign | 0x7c00 : sign | (roundedExponent << 10);
  }
  return sign | (halfExponent << 10) | roundedMantissa;
}

function roundRightToNearestEven(value: number, shift: number): number {
  const truncated = value >>> shift;
  const remainderMask = (1 << shift) - 1;
  const remainder = value & remainderMask;
  const halfway = 1 << (shift - 1);
  return remainder > halfway || (remainder === halfway && (truncated & 1) === 1)
    ? truncated + 1
    : truncated;
}
