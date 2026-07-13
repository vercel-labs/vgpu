import type { HostShareableLayout, LayoutMember, WGSLType } from "../src/runtime/reflect.ts";

export function writeLayoutValue(layout: HostShareableLayout, value: unknown): ArrayBuffer {
  const size = layout.size ?? byteLengthForRuntimeArray(layout, value);
  const buffer = new ArrayBuffer(size);
  writeValue(new DataView(buffer), layout, 0, value);
  return buffer;
}

export function writeValue(view: DataView, layout: HostShareableLayout, offset: number, value: unknown): void {
  if (layout.members) {
    const object = value as Record<string, unknown>;
    for (const member of layout.members) writeMember(view, member, offset, object[member.name]);
    return;
  }
  switch (layout.type.kind) {
    case "scalar": writeScalar(view, offset, layout.type.name, value); return;
    case "vector": writeVector(view, offset, layout.type, value); return;
    case "matrix": writeMatrix(view, layout, offset, value); return;
    case "array": writeArray(view, layout, offset, value); return;
    default: throw new Error(`No writer for ${layout.type.kind}`);
  }
}

function writeMember(view: DataView, member: LayoutMember, base: number, value: unknown): void {
  writeValue(view, member.layout, base + member.offset, value);
}

function writeScalar(view: DataView, offset: number, type: "f32" | "f16" | "i32" | "u32" | "bool", value: unknown): void {
  if (type === "f32") view.setFloat32(offset, Number(value), true);
  else if (type === "i32") view.setInt32(offset, Number(value), true);
  else if (type === "u32") view.setUint32(offset, Number(value), true);
  else if (type === "bool") view.setUint32(offset, value ? 1 : 0, true);
  else view.setUint16(offset, float32ToFloat16(Number(value)), true);
}

function writeVector(view: DataView, offset: number, type: Extract<WGSLType, { kind: "vector" }>, value: unknown): void {
  const values = value as ArrayLike<number>;
  const stride = scalarByteSize(type.element);
  for (let i = 0; i < type.width; i++) writeScalar(view, offset + i * stride, scalarName(type.element), values[i]);
}

function writeMatrix(view: DataView, layout: HostShareableLayout, offset: number, value: unknown): void {
  const matrix = layout.type as Extract<WGSLType, { kind: "matrix" }>;
  const values = value as ArrayLike<number>;
  const scalar = scalarByteSize(matrix.element);
  const stride = layout.stride ?? 16;
  for (let column = 0; column < matrix.columns; column++) {
    for (let row = 0; row < matrix.rows; row++) writeScalar(view, offset + column * stride + row * scalar, scalarName(matrix.element), values[column * matrix.rows + row]);
  }
}

function writeArray(view: DataView, layout: HostShareableLayout, offset: number, value: unknown): void {
  const values = value as readonly unknown[];
  const stride = layout.stride ?? layout.element?.size ?? 0;
  if (!layout.element) throw new Error("Array layout is missing element layout");
  for (let i = 0; i < values.length; i++) writeValue(view, layout.element, offset + i * stride, values[i]);
}

function byteLengthForRuntimeArray(layout: HostShareableLayout, value: unknown): number {
  const values = value as readonly unknown[];
  if (!layout.runtimeSized || !layout.stride) throw new Error("Cannot infer byte length for unsized layout");
  return layout.stride * values.length;
}

function scalarByteSize(type: WGSLType): number {
  return scalarName(type) === "f16" ? 2 : 4;
}

function scalarName(type: WGSLType): "f32" | "f16" | "i32" | "u32" | "bool" {
  if (type.kind !== "scalar") throw new Error(`Expected scalar type, got ${type.kind}`);
  return type.name;
}

function float32ToFloat16(value: number): number {
  const float = new Float32Array(1);
  const int = new Uint32Array(float.buffer);
  float[0] = value;
  const x = int[0]!;
  const sign = (x >> 16) & 0x8000;
  const mantissa = x & 0x007fffff;
  const exponent = (x >> 23) & 0xff;
  if (exponent === 0xff) return sign | (mantissa ? 0x7e00 : 0x7c00);
  const halfExponent = exponent - 127 + 15;
  if (halfExponent >= 0x1f) return sign | 0x7c00;
  if (halfExponent <= 0) {
    if (halfExponent < -10) return sign;
    return sign | ((mantissa | 0x00800000) >> (1 - halfExponent + 13));
  }
  return sign | (halfExponent << 10) | (mantissa >> 13);
}
