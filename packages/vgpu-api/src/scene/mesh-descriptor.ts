import type { Buffer as CoreBuffer, Device } from "@vgpu/core";
import type { EntryPointInputInfo, WGSLType } from "@vgpu/wgsl/reflect-source";
import type { MeshLike } from "../draw.ts";
import { meshAttributeAmbiguousError, meshAttributeUnmatchedError, meshDataMisalignedError, meshFormatMismatchError, meshInputMissingError, meshLayoutInvalidError, meshLimitExceededError, meshLocationConflictError, meshRangeInvalidError, meshWriteRangeError } from "../errors.ts";

export const meshLayoutResolver = Symbol("vgpu.mesh.layoutResolver");
export interface MeshLayoutResolvable {
  [meshLayoutResolver](inputs: readonly EntryPointInputInfo[], where: string): readonly GPUVertexBufferLayout[];
}

export type MeshData = ArrayBuffer | ArrayBufferView<ArrayBuffer>;

export interface MeshAttributeOverride {
  readonly format: GPUVertexFormat;
  readonly offset?: number;
  readonly location?: number;
}

export type MeshAttributes = { readonly [name: string]: GPUVertexFormat | MeshAttributeOverride };

export interface MeshBufferOptions {
  readonly attributes: MeshAttributes;
  readonly data?: MeshData;
  readonly buffer?: GPUBuffer;
  readonly stride?: number;
  readonly stepMode?: GPUVertexStepMode;
  readonly label?: string;
}

export interface MeshOptions {
  readonly buffers: readonly MeshBufferOptions[];
  readonly vertexCount?: number;
  readonly instanceCount?: number;
  readonly indices?: Uint16Array | Uint32Array | readonly number[];
  readonly indexBuffer?: GPUBuffer;
  readonly indexFormat?: GPUIndexFormat;
  readonly indexCount?: number;
  readonly topology?: GPUPrimitiveTopology;
  readonly label?: string;
}

export interface MeshBuffer {
  readonly gpu: GPUBuffer;
  readonly stride: number;
  readonly stepMode: GPUVertexStepMode;
  write(data: MeshData, byteOffset?: number): void;
}

export interface MeshSliceOptions {
  readonly firstIndex?: number;
  readonly indexCount?: number;
  readonly baseVertex?: number;
  readonly firstVertex?: number;
  readonly vertexCount?: number;
  readonly instanceCount?: number;
  readonly label?: string;
}

export interface MeshSlice extends MeshLike {
  readonly mesh: Mesh;
  readonly firstIndex?: number;
  readonly baseVertex?: number;
  readonly firstVertex?: number;
}

type AttrMeta = { readonly name: string; readonly format: GPUVertexFormat; readonly location?: number };
type NormalizedBuffer = {
  readonly layout: GPUVertexBufferLayout;
  readonly attributes: readonly AttrMeta[];
  readonly stride: number;
  readonly stepMode: GPUVertexStepMode;
  readonly byteLength?: number;
  readonly gpu: GPUBuffer;
  readonly owned?: CoreBuffer;
};

export class Mesh implements MeshLike {
  readonly vertexCount?: number;
  readonly indexCount?: number;
  readonly instanceCount?: number;
  readonly vertexBuffers: readonly GPUBuffer[];
  readonly indexBuffer?: GPUBuffer;
  readonly indexFormat?: GPUIndexFormat;
  readonly vertexBufferLayouts: readonly GPUVertexBufferLayout[];
  readonly topology: GPUPrimitiveTopology;
  readonly stripIndexFormat?: GPUIndexFormat;
  readonly buffers: readonly MeshBuffer[];
  private readonly indexOwned?: CoreBuffer;
  private readonly indexByteLength?: number;
  private readonly normalized: readonly NormalizedBuffer[];
  private readonly resolvedLayouts = new Map<string, readonly GPUVertexBufferLayout[]>();
  private destroyed = false;

  constructor(device: Device, opts: MeshOptions) {
    const where = "gpu.mesh";
    if (opts.buffers.length > 8) throw meshLimitExceededError(where, `Mesh declares ${opts.buffers.length} vertex buffers; WebGPU allows at most 8.`);
    let attrCount = 0;
    const locations = new Set<number>();
    const normalized = opts.buffers.map((buffer, i) => {
      const n = normalizeBuffer(device, buffer, `${where}.buffers[${i}]`);
      attrCount += n.attributes.length;
      for (const attr of n.attributes) {
        if (attr.location === undefined) continue;
        if (locations.has(attr.location)) throw meshLocationConflictError(`${where}.buffers[${i}]`, attr.location);
        locations.add(attr.location);
      }
      return n;
    });
    if (attrCount > 16) throw meshLimitExceededError(where, `Mesh declares ${attrCount} vertex attributes; WebGPU allows at most 16.`);

    const index = normalizeIndex(device, opts, where);
    this.topology = opts.topology ?? "triangle-list";
    this.stripIndexFormat = this.topology.endsWith("strip") ? (index.format ?? opts.indexFormat) : undefined;
    this.normalized = normalized;
    this.vertexBufferLayouts = Object.freeze(normalized.map((n) => n.layout));
    this.vertexBuffers = Object.freeze(normalized.map((n) => n.gpu));
    this.buffers = Object.freeze(normalized.map((n, i) => new InternalMeshBuffer(`${where}.buffers[${i}]`, n)));
    this.vertexCount = opts.vertexCount ?? deriveCount(normalized, "vertex");
    this.instanceCount = opts.instanceCount ?? deriveCount(normalized, "instance");
    this.indexBuffer = index.gpu;
    this.indexFormat = index.format;
    this.indexCount = opts.indexCount ?? index.count;
    this.indexOwned = index.owned;
    this.indexByteLength = index.byteLength;
  }

  [meshLayoutResolver](inputs: readonly EntryPointInputInfo[], where: string): readonly GPUVertexBufferLayout[] {
    if (this.destroyed) throw meshLayoutInvalidError(where, "Cannot construct a draw from a destroyed mesh.");
    const key = inputs.map((input) => `${input.name}:${input.location}:${shaderTypeBase(input.type)}`).join("|");
    const cached = this.resolvedLayouts.get(key);
    if (cached) return cached;
    const covered = new Set<number>();
    const names = this.normalized.flatMap((buffer) => buffer.attributes.map((attribute) => attribute.name));
    const layouts = this.normalized.map((buffer) => {
      const source = [...buffer.layout.attributes];
      const attributes = buffer.attributes.map((attribute, index) => {
        const matches = attribute.location === undefined ? inputs.filter((input) => input.name === attribute.name) : [];
        if (attribute.location === undefined && matches.length === 0) throw meshAttributeUnmatchedError(where, attribute.name, inputs.map((input) => input.name));
        if (matches.length > 1) throw meshAttributeAmbiguousError(where, attribute.name, matches.map((input) => input.location));
        const location = attribute.location ?? matches[0]!.location;
        if (covered.has(location)) throw meshLocationConflictError(where, location);
        covered.add(location);
        const input = inputs.find((candidate) => candidate.location === location);
        if (input && vertexFormatBase(attribute.format) !== shaderTypeBase(input.type)) throw meshFormatMismatchError(where, attribute.name, attribute.format, shaderTypeBase(input.type));
        return Object.freeze({ ...source[index]!, shaderLocation: location });
      });
      return Object.freeze({ arrayStride: buffer.layout.arrayStride, ...(buffer.layout.stepMode ? { stepMode: buffer.layout.stepMode } : {}), attributes: Object.freeze(attributes) });
    });
    for (const input of inputs) if (!covered.has(input.location)) throw meshInputMissingError(where, input.name, names);
    const result = Object.freeze(layouts);
    this.resolvedLayouts.set(key, result);
    return result;
  }

  slice(opts: MeshSliceOptions = {}): MeshSlice {
    return new InternalMeshSlice(this, opts);
  }

  write(data: MeshData, byteOffset = 0): void {
    const first = this.buffers[0];
    if (!first) throw meshWriteRangeError("mesh.write", "Mesh has no vertex buffer 0 to write.");
    first.write(data, byteOffset);
  }

  writeIndices(data: Uint16Array | Uint32Array, byteOffset = 0): void {
    if (!this.indexOwned || this.indexByteLength === undefined) throw meshWriteRangeError("mesh.writeIndices", "Mesh has no owned index buffer to write.");
    validateWriteRange("mesh.writeIndices", this.indexByteLength, data.byteLength, byteOffset);
    this.indexOwned.write(data as MeshData, byteOffset);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const buffer of this.buffers) (buffer as InternalMeshBuffer).destroyOwned();
    this.indexOwned?.destroy();
  }
}

class InternalMeshBuffer implements MeshBuffer {
  readonly gpu: GPUBuffer;
  readonly stride: number;
  readonly stepMode: GPUVertexStepMode;
  constructor(private readonly where: string, private readonly inner: NormalizedBuffer) {
    this.gpu = inner.gpu;
    this.stride = inner.stride;
    this.stepMode = inner.stepMode;
    Object.freeze(this);
  }
  write(data: MeshData, byteOffset = 0): void {
    if (!this.inner.owned || this.inner.byteLength === undefined) throw meshWriteRangeError(this.where, "Cannot write to a caller-owned mesh buffer through vgpu; write it directly.");
    validateWriteRange(this.where, this.inner.byteLength, byteLength(data), byteOffset);
    this.inner.owned.write(data, byteOffset);
  }
  destroyOwned(): void { this.inner.owned?.destroy(); }
}

class InternalMeshSlice implements MeshSlice {
  readonly mesh: Mesh;
  readonly vertexCount?: number;
  readonly indexCount?: number;
  readonly instanceCount?: number;
  readonly vertexBuffers: readonly GPUBuffer[];
  readonly indexBuffer?: GPUBuffer;
  readonly indexFormat?: GPUIndexFormat;
  readonly vertexBufferLayouts: readonly GPUVertexBufferLayout[];
  readonly topology?: GPUPrimitiveTopology;
  readonly stripIndexFormat?: GPUIndexFormat;
  readonly firstIndex?: number;
  readonly baseVertex?: number;
  readonly firstVertex?: number;
  [meshLayoutResolver](inputs: readonly EntryPointInputInfo[], where: string): readonly GPUVertexBufferLayout[] { return this.mesh[meshLayoutResolver](inputs, where); }
  constructor(mesh: Mesh, opts: MeshSliceOptions) {
    this.mesh = mesh;
    this.vertexBuffers = mesh.vertexBuffers;
    this.indexBuffer = mesh.indexBuffer;
    this.indexFormat = mesh.indexFormat;
    this.vertexBufferLayouts = mesh.vertexBufferLayouts;
    this.topology = mesh.topology;
    this.stripIndexFormat = mesh.stripIndexFormat;
    if (mesh.indexBuffer) {
      if (opts.firstVertex !== undefined || opts.vertexCount !== undefined) throw meshRangeInvalidError("mesh.slice", "Use firstIndex/indexCount/baseVertex for indexed mesh slices, not firstVertex/vertexCount.");
      const firstIndex = opts.firstIndex ?? 0;
      const max = mesh.indexCount ?? 0;
      const count = opts.indexCount ?? (max - firstIndex);
      validateRange("mesh.slice", "firstIndex", firstIndex, max);
      validateRange("mesh.slice", "indexCount", count, max - firstIndex);
      validateRange("mesh.slice", "baseVertex", opts.baseVertex ?? 0, Number.MAX_SAFE_INTEGER);
      this.firstIndex = firstIndex;
      this.indexCount = count;
      this.baseVertex = opts.baseVertex ?? 0;
      this.vertexCount = mesh.vertexCount;
    } else {
      if (opts.firstIndex !== undefined || opts.indexCount !== undefined || opts.baseVertex !== undefined) throw meshRangeInvalidError("mesh.slice", "Use firstVertex/vertexCount for non-indexed mesh slices, not index range fields.");
      const firstVertex = opts.firstVertex ?? 0;
      const max = mesh.vertexCount ?? 0;
      const count = opts.vertexCount ?? (max - firstVertex);
      validateRange("mesh.slice", "firstVertex", firstVertex, max);
      validateRange("mesh.slice", "vertexCount", count, max - firstVertex);
      this.firstVertex = firstVertex;
      this.vertexCount = count;
      this.indexCount = mesh.indexCount;
    }
    validateRange("mesh.slice", "instanceCount", opts.instanceCount ?? mesh.instanceCount ?? 0, Number.MAX_SAFE_INTEGER);
    this.instanceCount = opts.instanceCount ?? mesh.instanceCount;
    Object.freeze(this);
  }
}

export function mesh(device: Device, opts: MeshOptions): Mesh {
  return new Mesh(device, opts);
}

export function formatByteSize(fmt: GPUVertexFormat): number {
  if (fmt === "unorm10-10-10-2" || fmt === "unorm8x4-bgra") return 4;
  const m = /^(u?int|sint|unorm|snorm|float)(8|16|32)(?:x(2|3|4))?$/.exec(fmt);
  if (!m) return 0;
  return (Number(m[2]) / 8) * Number(m[3] ?? 1);
}

function normalizeBuffer(device: Device, opts: MeshBufferOptions, where: string): NormalizedBuffer {
  if (opts.data !== undefined && opts.buffer !== undefined) throw meshLayoutInvalidError(where, "A mesh buffer cannot specify both data and buffer.");
  const stepMode = opts.stepMode ?? "vertex";
  const attrs: GPUVertexAttribute[] = [];
  const metas: AttrMeta[] = [];
  let offset = 0;
  for (const [name, value] of Object.entries(opts.attributes)) {
    if (/^\d+$/.test(name)) throw meshLayoutInvalidError(where, `Attribute key '${name}' is integer-like and would reorder JavaScript object iteration.`);
    const desc = typeof value === "string" ? { format: value as GPUVertexFormat } : value;
    const size = formatByteSize(desc.format);
    if (!size) throw meshLayoutInvalidError(where, `Unknown GPUVertexFormat '${desc.format}'.`);
    const attrOffset = desc.offset ?? offset;
    const align = Math.min(4, size);
    if (!Number.isInteger(attrOffset) || attrOffset < 0 || attrOffset % align !== 0) throw meshLayoutInvalidError(where, `Attribute '${name}' offset ${String(attrOffset)} must be aligned to ${align} bytes.`);
    attrs.push({ shaderLocation: desc.location ?? attrs.length, offset: attrOffset, format: desc.format });
    metas.push({ name, format: desc.format, location: desc.location });
    offset = attrOffset + size;
  }
  const stride = opts.stride ?? roundUp4(offset);
  if (!Number.isInteger(stride) || stride <= 0 || stride > 2048 || stride % 4 !== 0) throw meshLayoutInvalidError(where, `Mesh buffer stride ${String(stride)} must be a positive multiple of 4 and <= 2048.`);
  for (const [i, attr] of attrs.entries()) {
    const size = formatByteSize(attr.format);
    if (attr.offset + size > stride) throw meshLayoutInvalidError(where, `Attribute '${metas[i]?.name}' at offset ${attr.offset} with size ${size} exceeds stride ${stride}.`);
  }
  const bytes = opts.data ? byteLength(opts.data) : undefined;
  if (bytes !== undefined && bytes % stride !== 0) throw meshDataMisalignedError(where, `Mesh data byteLength ${bytes} is not divisible by computed stride ${stride}.`);
  const owned = opts.data !== undefined ? device.createBuffer({ label: opts.label, size: Math.max(4, bytes ?? 0), usage: ["vertex", "copy_dst"] }) : undefined;
  if (owned && opts.data) owned.write(opts.data);
  const layout = Object.freeze({ arrayStride: stride, ...(opts.stepMode ? { stepMode } : {}), attributes: Object.freeze(attrs) as readonly GPUVertexAttribute[] });
  return { layout, attributes: Object.freeze(metas), stride, stepMode, byteLength: bytes ?? rawSize(opts.buffer), gpu: owned?.gpu ?? requiredBuffer(opts.buffer, where), owned };
}

function normalizeIndex(device: Device, opts: MeshOptions, where: string): { readonly gpu?: GPUBuffer; readonly owned?: CoreBuffer; readonly format?: GPUIndexFormat; readonly count?: number; readonly byteLength?: number } {
  if (opts.indices !== undefined && opts.indexBuffer !== undefined) throw meshLayoutInvalidError(where, "A mesh cannot specify both indices and indexBuffer.");
  if (opts.indices === undefined) return { gpu: opts.indexBuffer, format: opts.indexFormat, count: opts.indexCount, byteLength: rawSize(opts.indexBuffer) };
  const data = (Array.isArray(opts.indices) ? new Uint32Array(opts.indices) : opts.indices) as Uint16Array | Uint32Array;
  const format: GPUIndexFormat = data instanceof Uint16Array ? "uint16" : "uint32";
  const bytes = data.byteLength;
  if (bytes % (format === "uint16" ? 2 : 4) !== 0) throw meshDataMisalignedError(where, `Index data byteLength ${bytes} is invalid for ${format}.`);
  const owned = device.createBuffer({ label: opts.label ? `${opts.label}.indices` : undefined, size: Math.max(4, bytes), usage: ["index", "copy_dst"] });
  owned.write(data as MeshData);
  return { gpu: owned.gpu, owned, format, count: data.length, byteLength: bytes };
}

function deriveCount(buffers: readonly NormalizedBuffer[], stepMode: GPUVertexStepMode): number | undefined {
  const b = buffers.find((item) => item.stepMode === stepMode && item.byteLength !== undefined);
  return b ? Math.floor((b.byteLength ?? 0) / b.stride) : undefined;
}

function requiredBuffer(buffer: GPUBuffer | undefined, where: string): GPUBuffer {
  if (!buffer) throw meshLayoutInvalidError(where, "A mesh buffer must specify data or buffer.");
  return buffer;
}
function rawSize(buffer: GPUBuffer | undefined): number | undefined { return typeof (buffer as { size?: unknown } | undefined)?.size === "number" ? (buffer as { size: number }).size : undefined; }
function byteLength(data: MeshData): number { return data instanceof ArrayBuffer ? data.byteLength : data.byteLength; }
function roundUp4(n: number): number { return (n + 3) & ~3; }
function validateWriteRange(where: string, capacity: number, length: number, offset: number): void {
  if (!Number.isInteger(offset) || offset < 0 || offset + length > capacity) throw meshWriteRangeError(where, `Write of ${length} bytes at offset ${String(offset)} exceeds buffer byteLength ${capacity}.`);
}
function validateRange(where: string, field: string, value: number, max: number): void {
  if (!Number.isInteger(value) || value < 0 || value > max) throw meshRangeInvalidError(where, `${field} must be an integer in [0, ${max}], received ${String(value)}.`);
}
function vertexFormatBase(format: GPUVertexFormat): "f32" | "i32" | "u32" {
  if (format.startsWith("sint")) return "i32";
  if (format.startsWith("uint")) return "u32";
  return "f32";
}
function shaderTypeBase(type: WGSLType): string {
  if (type.kind === "scalar") return type.name;
  if (type.kind === "vector" || type.kind === "matrix" || type.kind === "atomic") return shaderTypeBase(type.element);
  return type.kind;
}
