import type { Buffer as CoreBuffer, Device } from "@vgpu/core";
import type { EntryPointInputInfo, WGSLType } from "@vgpu/wgsl/reflect-source";
import type { MeshLike } from "../draw.ts";
import { meshAttributeAmbiguousError, meshAttributeUnmatchedError, meshDataMisalignedError, meshFormatMismatchError, meshInputMissingError, meshLayoutInvalidError, meshLimitExceededError, meshLocationConflictError, meshRangeInvalidError, meshWriteRangeError } from "../errors.ts";

/** @internal Resolves named mesh attributes against reflected shader inputs. */
export const meshLayoutResolver = Symbol("vgpu.mesh.layoutResolver");
/** @internal Implemented by v2 meshes and slices for draw-time layout resolution. */
export interface MeshLayoutResolvable {
  /** Resolves and validates concrete shader locations for a vertex entry point. */
  [meshLayoutResolver](inputs: readonly EntryPointInputInfo[], where: string): readonly GPUVertexBufferLayout[];
}

/** CPU-side bytes accepted when creating or updating an owned mesh buffer. */
export type MeshData = ArrayBuffer | ArrayBufferView<ArrayBuffer>;

/** Overrides the format and optional byte offset or shader location of a named attribute. */
export interface MeshAttributeOverride {
  readonly format: GPUVertexFormat;
  readonly offset?: number;
  readonly location?: number;
}

/** Named attributes in declaration order for one vertex buffer stream. */
export type MeshAttributes = { readonly [name: string]: GPUVertexFormat | MeshAttributeOverride };

/** Describes one owned-data or caller-owned vertex buffer stream. */
export interface MeshBufferOptions {
  readonly attributes: MeshAttributes;
  readonly data?: MeshData;
  readonly buffer?: GPUBuffer;
  readonly stride?: number;
  readonly stepMode?: GPUVertexStepMode;
  readonly label?: string;
}

/** Options for constructing an immutable mesh layout and its GPU buffers. */
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

/** Public handle for one fixed-size mesh vertex buffer stream. */
export interface MeshBuffer {
  readonly gpu: GPUBuffer;
  readonly stride: number;
  readonly stepMode: GPUVertexStepMode;
  /** Updates bytes in an owned buffer without changing its identity or size. */
  write(data: MeshData, byteOffset?: number): void;
}

/** Selects an immutable indexed or non-indexed range view of a mesh. */
export interface MeshSliceOptions {
  readonly firstIndex?: number;
  readonly indexCount?: number;
  readonly baseVertex?: number;
  readonly firstVertex?: number;
  readonly vertexCount?: number;
  readonly instanceCount?: number;
  readonly label?: string;
}

/** Frozen range view that shares its parent mesh's buffers and pipeline layout. */
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

/** Immutable mesh layout with fixed-size mutable owned buffers. */
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
  readonly #indexOwned?: CoreBuffer;
  readonly #indexByteLength?: number;
  readonly #normalized: readonly NormalizedBuffer[];
  readonly #resolvedLayouts = new Map<string, readonly GPUVertexBufferLayout[]>();
  #destroyed = false;

  constructor(device: Device, opts: MeshOptions) {
    const where = "gpu.mesh";
    if (opts.buffers.length > 8) throw meshLimitExceededError(where, `${opts.buffers.length} vertex buffers exceed limit 8.`);
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
    const maxAttributes = device.gpu.limits.maxVertexAttributes;
    if (attrCount > maxAttributes) throw meshLimitExceededError(where, `${attrCount} attributes exceed device limit ${maxAttributes}.`);

    const topology = opts.topology ?? "triangle-list";
    if (!TOPOLOGIES.has(topology)) throw meshLayoutInvalidError(where, `Invalid topology: ${String(topology)}.`);
    const index = normalizeIndex(device, opts, where);
    const vertexCapacity = deriveCount(normalized, "vertex");
    const instanceCapacity = deriveCount(normalized, "instance");
    requireExplicitRawCount(normalized, "vertex", opts.vertexCount ?? vertexCapacity, where);
    requireExplicitRawCount(normalized, "instance", opts.instanceCount ?? instanceCapacity, where);
    validateOptionalCapacity(where, "vertexCount", opts.vertexCount, vertexCapacity);
    validateOptionalCapacity(where, "instanceCount", opts.instanceCount, instanceCapacity);
    validateOptionalCapacity(where, "indexCount", opts.indexCount, index.count);
    this.topology = topology;
    this.stripIndexFormat = topology.endsWith("strip") ? index.format : undefined;
    this.#normalized = normalized;
    this.vertexBufferLayouts = Object.freeze(normalized.map((n) => n.layout));
    this.vertexBuffers = Object.freeze(normalized.map((n) => n.gpu));
    this.buffers = Object.freeze(normalized.map((n, i) => new InternalMeshBuffer(`${where}.buffers[${i}]`, n)));
    this.vertexCount = opts.vertexCount ?? vertexCapacity;
    this.instanceCount = opts.instanceCount ?? instanceCapacity;
    this.indexBuffer = index.gpu;
    this.indexFormat = index.format;
    this.indexCount = opts.indexCount ?? index.count;
    this.#indexOwned = index.owned;
    this.#indexByteLength = index.byteLength;
    lockPublicMeshProperties(this);
  }

  /** @internal Resolves named attributes for one reflected vertex entry point. */
  [meshLayoutResolver](inputs: readonly EntryPointInputInfo[], where: string): readonly GPUVertexBufferLayout[] {
    if (this.#destroyed) throw meshLayoutInvalidError(where, "Mesh is destroyed; create a live mesh.");
    const key = inputs.map((input) => `${input.name}:${input.location}:${shaderTypeBase(input.type)}`).join("|");
    const cached = this.#resolvedLayouts.get(key);
    if (cached) return cached;
    const covered = new Set<number>();
    const names = this.#normalized.flatMap((buffer) => buffer.attributes.map((attribute) => attribute.name));
    const layouts = this.#normalized.map((buffer) => {
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
    this.#resolvedLayouts.set(key, result);
    return result;
  }

  /** Creates a frozen range view sharing this mesh's buffers and layout identity. */
  slice(opts: MeshSliceOptions = {}): MeshSlice {
    return new InternalMeshSlice(this, opts);
  }

  /** Updates bytes in vertex buffer stream 0 without resizing it. */
  write(data: MeshData, byteOffset = 0): void {
    const first = this.buffers[0];
    if (!first) throw meshWriteRangeError("mesh.write", "No vertex buffer 0; add one before writing.");
    first.write(data, byteOffset);
  }

  /** Updates bytes in the owned index buffer without resizing it. */
  writeIndices(data: Uint16Array | Uint32Array, byteOffset = 0): void {
    if (this.#destroyed) throw meshWriteRangeError("mesh.writeIndices", "Mesh is destroyed; create a new mesh before writing.");
    if (!this.#indexOwned || this.#indexByteLength === undefined) throw meshWriteRangeError("mesh.writeIndices", "No owned index buffer; write caller-owned buffers directly.");
    validateWriteRange("mesh.writeIndices", this.#indexByteLength, data.byteLength, byteOffset);
    this.#indexOwned.write(data as MeshData, byteOffset);
  }

  /** Destroys buffers owned by this mesh; caller-owned buffers are untouched. */
  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    for (const buffer of this.buffers) (buffer as InternalMeshBuffer).destroyOwned();
    this.#indexOwned?.destroy();
  }
}

class InternalMeshBuffer implements MeshBuffer {
  readonly gpu: GPUBuffer;
  readonly stride: number;
  readonly stepMode: GPUVertexStepMode;
  readonly #state = { destroyed: false };
  constructor(private readonly where: string, private readonly inner: NormalizedBuffer) {
    this.gpu = inner.gpu;
    this.stride = inner.stride;
    this.stepMode = inner.stepMode;
    Object.freeze(this);
  }
  write(data: MeshData, byteOffset = 0): void {
    if (this.#state.destroyed) throw meshWriteRangeError(this.where, "Mesh is destroyed; create a new mesh before writing.");
    if (!this.inner.owned || this.inner.byteLength === undefined) throw meshWriteRangeError(this.where, "Caller-owned buffer; write it directly.");
    validateWriteRange(this.where, this.inner.byteLength, byteLength(data), byteOffset);
    this.inner.owned.write(data, byteOffset);
  }
  destroyOwned(): void { this.#state.destroyed = true; this.inner.owned?.destroy(); }
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
      if (opts.firstVertex !== undefined || opts.vertexCount !== undefined) throw meshRangeInvalidError("mesh.slice", "Indexed slice needs firstIndex/indexCount/baseVertex; omit vertex range fields.");
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
      if (opts.firstIndex !== undefined || opts.indexCount !== undefined || opts.baseVertex !== undefined) throw meshRangeInvalidError("mesh.slice", "Non-indexed slice needs firstVertex/vertexCount; omit index range fields.");
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

/** Constructs a validated v2 mesh for the supplied device. */
export function mesh(device: Device, opts: MeshOptions): Mesh {
  return new Mesh(device, opts);
}

/** Returns the byte width of one value in a WebGPU vertex format. */
export function formatByteSize(fmt: GPUVertexFormat): number {
  if (fmt === "unorm10-10-10-2" || fmt === "unorm8x4-bgra") return 4;
  const m = /^(float|uint|sint|unorm|snorm)(8|16|32)(?:x([234]))?$/.exec(fmt);
  if (!m) return 0;
  const [, kind, bits, lanes] = m;
  if (bits === "32" ? /norm/.test(kind!) : !lanes || lanes === "3" || (bits === "8" && kind === "float")) return 0;
  return (Number(bits) / 8) * Number(lanes ?? 1);
}

function normalizeBuffer(device: Device, opts: MeshBufferOptions, where: string): NormalizedBuffer {
  if (opts.data !== undefined && opts.buffer !== undefined) throw meshLayoutInvalidError(where, "Choose data or buffer, not both.");
  const stepMode = opts.stepMode ?? "vertex";
  if (stepMode !== "vertex" && stepMode !== "instance") throw meshLayoutInvalidError(where, `Invalid stepMode: ${String(stepMode)}.`);
  const attrs: GPUVertexAttribute[] = [];
  const metas: AttrMeta[] = [];
  let packedSize = 0;
  for (const [name, value] of Object.entries(opts.attributes)) {
    if (/^\d+$/.test(name)) throw meshLayoutInvalidError(where, `Attribute '${name}' is numeric; use a non-numeric name.`);
    const desc = typeof value === "string" ? { format: value as GPUVertexFormat } : value;
    const size = formatByteSize(desc.format);
    if (!size) throw meshLayoutInvalidError(where, `Unknown GPUVertexFormat '${desc.format}'.`);
    const attrOffset = desc.offset ?? packedSize;
    const align = Math.min(4, size);
    if (!Number.isInteger(attrOffset) || attrOffset < 0 || attrOffset % align !== 0) throw meshLayoutInvalidError(where, `Attribute '${name}' offset ${String(attrOffset)} needs ${align}-byte alignment.`);
    if (desc.location !== undefined && (!Number.isInteger(desc.location) || desc.location < 0 || desc.location >= device.gpu.limits.maxVertexAttributes)) throw meshLayoutInvalidError(where, `Location ${String(desc.location)} for '${name}' is outside limit ${device.gpu.limits.maxVertexAttributes}.`);
    attrs.push({ shaderLocation: desc.location ?? attrs.length, offset: attrOffset, format: desc.format });
    metas.push({ name, format: desc.format, location: desc.location });
    packedSize += size;
  }
  const stride = opts.stride ?? roundUp4(packedSize);
  if (!Number.isInteger(stride) || stride <= 0 || stride > 2048 || stride % 4 !== 0) throw meshLayoutInvalidError(where, `Stride ${String(stride)} must be 4-aligned in [4,2048].`);
  for (const [i, attr] of attrs.entries()) {
    const size = formatByteSize(attr.format);
    if (attr.offset + size > stride) throw meshLayoutInvalidError(where, `Attribute '${metas[i]?.name}' (${attr.offset}+${size}) exceeds stride ${stride}.`);
  }
  const bytes = opts.data ? byteLength(opts.data) : undefined;
  if (bytes !== undefined && bytes % stride !== 0) throw meshDataMisalignedError(where, `Data byteLength ${bytes} is not divisible by stride ${stride}.`);
  const owned = opts.data !== undefined ? device.createBuffer({ label: opts.label, size: Math.max(4, bytes ?? 0), usage: ["vertex", "copy_dst"] }) : undefined;
  if (owned && opts.data) owned.write(opts.data);
  const layout = Object.freeze({ arrayStride: stride, ...(opts.stepMode ? { stepMode } : {}), attributes: Object.freeze(attrs) as readonly GPUVertexAttribute[] });
  return { layout, attributes: Object.freeze(metas), stride, stepMode, byteLength: bytes, gpu: owned?.gpu ?? requiredBuffer(opts.buffer, where), owned };
}

function normalizeIndex(device: Device, opts: MeshOptions, where: string): { readonly gpu?: GPUBuffer; readonly owned?: CoreBuffer; readonly format?: GPUIndexFormat; readonly count?: number; readonly byteLength?: number } {
  if (opts.indices !== undefined && opts.indexBuffer !== undefined) throw meshLayoutInvalidError(where, "Choose indices or indexBuffer, not both.");
  if (opts.indices === undefined) {
    const rawFields = [opts.indexBuffer, opts.indexFormat, opts.indexCount];
    const present = rawFields.filter((value) => value !== undefined).length;
    if (present !== 0 && present !== 3) throw meshLayoutInvalidError(where, "Provide indexBuffer, indexFormat, and indexCount together.");
    if (opts.indexFormat !== undefined && opts.indexFormat !== "uint16" && opts.indexFormat !== "uint32") throw meshLayoutInvalidError(where, `Unknown index format '${String(opts.indexFormat)}'.`);
    if (opts.indexCount !== undefined) validateRange(where, "indexCount", opts.indexCount, Number.MAX_SAFE_INTEGER);
    return { gpu: opts.indexBuffer, format: opts.indexFormat, count: opts.indexCount };
  }
  if (opts.indexFormat !== undefined) throw meshLayoutInvalidError(where, "indices infer format; omit indexFormat.");
  const data = (Array.isArray(opts.indices) ? new Uint32Array(opts.indices) : opts.indices) as Uint16Array | Uint32Array;
  const format: GPUIndexFormat = data instanceof Uint16Array ? "uint16" : "uint32";
  const bytes = data.byteLength;
  if (bytes % (format === "uint16" ? 2 : 4) !== 0) throw meshDataMisalignedError(where, `Index byteLength ${bytes} is invalid for ${format}.`);
  const owned = device.createBuffer({ label: opts.label ? `${opts.label}.indices` : undefined, size: Math.max(4, bytes), usage: ["index", "copy_dst"] });
  owned.write(data as MeshData);
  return { gpu: owned.gpu, owned, format, count: data.length, byteLength: bytes };
}

function deriveCount(buffers: readonly NormalizedBuffer[], stepMode: GPUVertexStepMode): number | undefined {
  let count: number | undefined;
  for (const buffer of buffers) if (buffer.stepMode === stepMode && buffer.byteLength !== undefined) count = Math.min(count ?? Infinity, Math.floor(buffer.byteLength / buffer.stride));
  return count;
}

function requireExplicitRawCount(buffers: readonly NormalizedBuffer[], stepMode: GPUVertexStepMode, count: number | undefined, where: string): void {
  if (count === undefined && buffers.some((buffer) => buffer.stepMode === stepMode && buffer.byteLength === undefined)) throw meshLayoutInvalidError(where, `Raw ${stepMode} buffer needs ${stepMode}Count.`);
}

function validateOptionalCapacity(where: string, field: string, value: number | undefined, capacity: number | undefined): void {
  if (value === undefined) return;
  validateRange(where, field, value, capacity ?? Number.MAX_SAFE_INTEGER);
}

function lockPublicMeshProperties(mesh: Mesh): void {
  for (const key of Object.keys(mesh)) if (key !== "destroyed") Object.defineProperty(mesh, key, { writable: false, configurable: false });
}

const TOPOLOGIES = new Set<unknown>(["point-list", "line-list", "line-strip", "triangle-list", "triangle-strip"]);

function requiredBuffer(buffer: GPUBuffer | undefined, where: string): GPUBuffer {
  if (!buffer) throw meshLayoutInvalidError(where, "Provide mesh buffer data or buffer.");
  return buffer;
}
function byteLength(data: MeshData): number { return data.byteLength; }
function roundUp4(n: number): number { return (n + 3) & ~3; }
function validateWriteRange(where: string, capacity: number, length: number, offset: number): void {
  if (!Number.isInteger(offset) || offset < 0 || offset % 4 !== 0 || length % 4 !== 0 || offset + length > capacity) throw meshWriteRangeError(where, `Write size ${length}/offset ${String(offset)} must be 4-aligned within ${capacity} bytes.`);
}
function validateRange(where: string, field: string, value: number, max: number): void {
  if (!Number.isInteger(value) || value < 0 || value > max) throw meshRangeInvalidError(where, `${field}=${String(value)} must be an integer in [0,${max}].`);
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
