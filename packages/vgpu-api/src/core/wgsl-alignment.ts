import { ValidationError } from "@vgpu/core";

export type WgslUniformType =
  | "f32" | "u32" | "i32"
  | "vec2f" | "vec3f" | "vec4f"
  | "vec2u" | "vec3u" | "vec4u"
  | "vec2i" | "vec3i" | "vec4i"
  | "mat3x3f" | "mat4x4f";

export interface UniformField {
  readonly name: string;
  readonly type: WgslUniformType;
  readonly offset: number;
  readonly size: number;
  readonly align: number;
}

export interface UniformLayoutInfo {
  readonly fields: readonly UniformField[];
  readonly offsets: Readonly<Record<string, number>>;
  readonly byteSize: number;
}

const TYPES = {
  f32: { size: 4, align: 4 }, u32: { size: 4, align: 4 }, i32: { size: 4, align: 4 },
  vec2f: { size: 8, align: 8 }, vec2u: { size: 8, align: 8 }, vec2i: { size: 8, align: 8 },
  vec3f: { size: 12, align: 16 }, vec3u: { size: 12, align: 16 }, vec3i: { size: 12, align: 16 },
  vec4f: { size: 16, align: 16 }, vec4u: { size: 16, align: 16 }, vec4i: { size: 16, align: 16 },
  mat3x3f: { size: 48, align: 16 }, mat4x4f: { size: 64, align: 16 },
} as const satisfies Record<WgslUniformType, { readonly size: number; readonly align: number }>;

export function isWgslUniformType(value: unknown): value is WgslUniformType {
  return typeof value === "string" && value in TYPES;
}

export function alignUniforms(schema: Record<string, WgslUniformType>): UniformLayoutInfo {
  let offset = 0;
  let largestAlign = 16;
  const offsets: Record<string, number> = {};
  const fields = Object.entries(schema).map(([name, type]) => {
    const info = TYPES[type];
    offset = roundUp(offset, info.align);
    largestAlign = Math.max(largestAlign, info.align);
    offsets[name] = offset;
    const field = { name, type, offset, size: info.size, align: info.align };
    offset += info.size;
    return field;
  });
  return { fields, offsets, byteSize: fields.length === 0 ? 0 : roundUp(offset, largestAlign) };
}

export type UniformValue = number | readonly number[] | Float32Array | Uint32Array | Int32Array;

export interface WriteUniformFieldOptions {
  readonly exactLength?: boolean;
  readonly where?: string;
}

export function wgslType(type: WgslUniformType): string {
  if (type === "f32" || type === "u32" || type === "i32") return type;
  if (type === "mat3x3f") return "mat3x3<f32>";
  if (type === "mat4x4f") return "mat4x4<f32>";
  const kind = type.at(-1) === "f" ? "f32" : type.at(-1) === "u" ? "u32" : "i32";
  return `${type.slice(0, 4)}<${kind}>`;
}

export function uniformValueCount(type: WgslUniformType): number {
  if (type === "mat3x3f") return 9;
  if (type === "mat4x4f") return 16;
  return TYPES[type].size / 4;
}

export function writeUniformField(view: DataView, field: UniformField, value: unknown, opts: WriteUniformFieldOptions = {}): void {
  const needed = uniformValueCount(field.type);
  const data = uniformFieldData(field, value, needed, opts.where ?? "writeUniformField");
  if (data.length < needed || (opts.exactLength === true && data.length !== needed)) {
    const verb = opts.exactLength === true ? "must have exactly" : "needs";
    throw invalidUniformField(opts.where ?? "writeUniformField", `Uniform '${field.name}' ${verb} ${needed} value(s).`);
  }
  const setter = field.type === "u32" || field.type.endsWith("u") ? "setUint32" : field.type === "i32" || field.type.endsWith("i") ? "setInt32" : "setFloat32";
  if (field.type === "mat3x3f") {
    for (let column = 0; column < 3; column++) for (let row = 0; row < 3; row++) set(view, setter, field.offset + column * 16 + row * 4, data[column * 3 + row]!);
    return;
  }
  for (let index = 0; index < needed; index++) set(view, setter, field.offset + index * 4, data[index]!);
}

function uniformFieldData(field: UniformField, value: unknown, needed: number, where: string): readonly number[] {
  if (typeof value === "number") {
    if (needed !== 1) throw invalidUniformField(where, `Uniform '${field.name}' needs ${needed} value(s).`);
    return [value];
  }
  if (isNumberArrayLike(value)) return Array.from(value);
  throw invalidUniformField(where, `Uniform '${field.name}' needs ${needed} value(s).`);
}

function isNumberArrayLike(value: unknown): value is readonly number[] | Float32Array | Uint32Array | Int32Array {
  return Array.isArray(value) || value instanceof Float32Array || value instanceof Uint32Array || value instanceof Int32Array;
}

function set(view: DataView, setter: "setFloat32" | "setUint32" | "setInt32", offset: number, value: number): void { view[setter](offset, value, true); }

function invalidUniformField(where: string, message: string): ValidationError {
  return new ValidationError({ code: "VGPU-CORE-INVALID-USAGE", message, where });
}

function roundUp(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}
