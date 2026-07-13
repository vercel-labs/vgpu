import { Buffer, Texture, type Device, type ResourceIdentity, type UnsubscribeResourceDestroy } from "@vgpu/core";
import type { BindingInfo, HostShareableLayout, LayoutMember, ReflectedBindingLayout, Reflection, WGSLType } from "@vgpu/wgsl/runtime";
import { identityKey, type BindGroupCache, type BindGroupIdentityPart } from "./bind-cache.ts";
import { claimedGroupSetError, neverSetError, ownershipFlipError, unsupportedError } from "./errors.ts";

export type SetBag = Record<string, unknown>;
export type BindingOwnership = "lib" | "user";

export interface SetCoreOptions {
  readonly device: Device;
  readonly label: string;
  readonly drawId: number;
  readonly reflection: Reflection;
  readonly bindGroupLayouts: ReadonlyMap<number, GPUBindGroupLayout>;
  readonly cache: BindGroupCache;
}

export interface SetCore {
  readonly groups: readonly number[];
  set(values: SetBag): void;
  claimGroup(group: number, bindGroup: GPUBindGroup): void;
  layout(group: number): GPUBindGroupLayout;
  bindGroups(): readonly { readonly group: number; readonly bindGroup: GPUBindGroup; readonly offsets: readonly number[] }[];
  bindingState(name: string): BindingState | undefined;
}

export interface BindingState {
  readonly info: BindingInfo;
  readonly ownership: BindingOwnership;
  readonly resource: GPUBindingResource;
  readonly identity: BindGroupIdentityPart;
}

type MutableBindingState = {
  readonly info: BindingInfo;
  ownership?: BindingOwnership;
  readonly memberOwnership: Map<string, BindingOwnership>;
  buffer?: Buffer;
  bytes?: ArrayBuffer;
  libValue?: unknown;
  resource?: GPUBindingResource;
  identity?: BindGroupIdentityPart;
  unsubscribe?: UnsubscribeResourceDestroy;
};

let nextSyntheticResourceId = 1;

export function createSetCore(options: SetCoreOptions): SetCore {
  const bindings = new Map<string, MutableBindingState>();
  const groups = [...new Set(options.reflection.bindings.map((binding) => binding.group))].sort((a, b) => a - b);
  const claimedGroups = new Map<number, GPUBindGroup>();

  for (const binding of options.reflection.bindings) bindings.set(binding.name, { info: binding, memberOwnership: new Map() });

  function set(values: SetBag): void {
    for (const [name, value] of Object.entries(values)) {
      const direct = bindings.get(name);
      if (direct) {
        setBinding(direct, name, value);
        continue;
      }
      const member = findMemberBinding(name);
      if (!member) throw unsupportedError(`${options.label}.set`, `Binding '${name}' no existe en '${options.label}'.`);
      setBindingMember(member, name, value);
    }
  }

  function setBinding(state: MutableBindingState, name: string, value: unknown): void {
    if (claimedGroups.has(state.info.group)) throw claimedGroupSetError(options.label, state.info.group);
    const ownership = isPlainValue(value) ? "lib" : "user";
    if (state.ownership && state.ownership !== ownership) throw ownershipFlipError(name, state.ownership);
    state.ownership ??= ownership;
    if (ownership === "lib") setLibOwned(state, mergeLibValue(state.libValue, value));
    else setUserOwned(state, value);
  }

  function setBindingMember(state: MutableBindingState, memberName: string, value: unknown): void {
    if (claimedGroups.has(state.info.group)) throw claimedGroupSetError(options.label, state.info.group);
    const ownership = isPlainValue(value) ? "lib" : "user";
    if (state.ownership && state.ownership !== ownership) throw ownershipFlipError(memberName, state.ownership);
    state.ownership ??= ownership;
    const previousMemberOwnership = state.memberOwnership.get(memberName);
    if (previousMemberOwnership && previousMemberOwnership !== ownership) throw ownershipFlipError(memberName, previousMemberOwnership);
    state.memberOwnership.set(memberName, ownership);
    if (ownership !== "lib") throw unsupportedError(`${options.label}.set`, `Binding member '${memberName}' no puede recibir recursos; seteá el binding completo '${state.info.name}'.`);
    setLibOwned(state, { ...objectValue(state.libValue), [memberName]: value });
  }

  function findMemberBinding(memberName: string): MutableBindingState | undefined {
    let match: MutableBindingState | undefined;
    for (const state of bindings.values()) {
      if (!state.info.layout?.members?.some((member) => member.name === memberName)) continue;
      if (match) throw unsupportedError(`${options.label}.set`, `Binding member '${memberName}' es ambiguo en '${options.label}'; seteá el binding completo.`);
      match = state;
    }
    return match;
  }

  function mergeLibValue(previous: unknown, value: unknown): unknown {
    if (isPlainObject(previous) && isPlainObject(value)) return { ...previous, ...value };
    return value;
  }

  function objectValue(value: unknown): Record<string, unknown> {
    return isPlainObject(value) ? value : {};
  }

  function setLibOwned(state: MutableBindingState, value: unknown): void {
    if (state.info.kind !== "buffer" || !state.info.layout?.size) {
      throw unsupportedError(`${options.label}.set`, `Binding '${state.info.name}' no acepta valores JS planos; pasá un recurso compatible.`);
    }
    const layout = state.info.layout;
    state.libValue = value;
    const bytes = writeLayoutValue(layout, value);
    if (!state.buffer) {
      const size = layout.size;
      if (size === undefined) throw unsupportedError(`${options.label}.set`, `Binding '${state.info.name}' tiene tamaño runtime y no acepta empaquetado automático.`);
      state.buffer = options.device.createBuffer({ size, usage: ["uniform", "copy_dst"], label: `${options.label}.${state.info.name}` });
      state.resource = { buffer: state.buffer.gpu, offset: 0, size };
      state.identity = state.buffer.resourceIdentity;
      state.unsubscribe = state.buffer.onDestroy(() => options.cache.evictIdentity(state.buffer!.resourceIdentity));
    }
    state.bytes = bytes;
    state.buffer.write(bytes, 0);
  }

  function setUserOwned(state: MutableBindingState, value: unknown): void {
    const normalized = normalizeResource(value);
    state.resource = normalized.resource;
    state.identity = normalized.identity;
    state.unsubscribe?.();
    state.unsubscribe = normalized.unsubscribe?.(() => options.cache.evictIdentity(normalized.identity));
  }

  function claimGroup(group: number, bindGroup: GPUBindGroup): void {
    claimedGroups.set(group, bindGroup);
  }

  function layout(group: number): GPUBindGroupLayout {
    const bgl = options.bindGroupLayouts.get(group);
    if (!bgl) throw unsupportedError(`${options.label}.layout`, `No existe @group(${group}) en '${options.label}'.`);
    return bgl;
  }

  function bindGroups(): readonly { readonly group: number; readonly bindGroup: GPUBindGroup; readonly offsets: readonly number[] }[] {
    const result: { group: number; bindGroup: GPUBindGroup; offsets: readonly number[] }[] = [];
    for (const group of groups) {
      const claimed = claimedGroups.get(group);
      if (claimed) {
        result.push({ group, bindGroup: claimed, offsets: [] });
        continue;
      }
      const groupBindings = options.reflection.bindings.filter((binding) => binding.group === group);
      const entries: GPUBindGroupEntry[] = [];
      const identities: BindGroupIdentityPart[] = [];
      for (const binding of groupBindings) {
        const state = bindings.get(binding.name);
        if (!state?.resource || !state.identity) throw neverSetError(options.label, binding);
        entries.push({ binding: binding.binding, resource: state.resource });
        identities.push(state.identity);
      }
      const bgl = layout(group);
      const bindGroup = options.cache.getOrCreate(options.drawId, group, identities, () => options.device.gpu.createBindGroup({
        label: `${options.label}.group${group}`,
        layout: bgl,
        entries,
      }));
      result.push({ group, bindGroup, offsets: [] });
    }
    return result;
  }

  return {
    get groups() { return groups; },
    set,
    claimGroup,
    layout,
    bindGroups,
    bindingState(name) {
      const state = bindings.get(name);
      if (!state?.ownership || !state.resource || !state.identity) return undefined;
      return { info: state.info, ownership: state.ownership, resource: state.resource, identity: state.identity };
    },
  };
}

export function bindGroupLayoutEntriesForGroup(bindings: readonly BindingInfo[], group: number): GPUBindGroupLayoutEntry[] {
  return bindings.filter((binding) => binding.group === group).map((binding) => ({
    binding: binding.binding,
    visibility: visibilityForBinding(binding),
    ...layoutEntry(binding),
  }));
}

export function bindGroupLayoutsForReflection(device: Device, label: string, reflection: Reflection): ReadonlyMap<number, GPUBindGroupLayout> {
  const map = new Map<number, GPUBindGroupLayout>();
  const groups = [...new Set(reflection.bindings.map((binding) => binding.group))].sort((a, b) => a - b);
  for (const group of groups) {
    map.set(group, device.gpu.createBindGroupLayout({
      label: `${label}.group${group}.bgl`,
      entries: bindGroupLayoutEntriesForGroup(reflection.bindings, group),
    }));
  }
  return map;
}

export function pipelineLayoutFor(device: Device, bindGroupLayouts: ReadonlyMap<number, GPUBindGroupLayout>): GPUPipelineLayout {
  const maxGroup = Math.max(-1, ...bindGroupLayouts.keys());
  const layouts: GPUBindGroupLayout[] = [];
  for (let i = 0; i <= maxGroup; i++) {
    const layout = bindGroupLayouts.get(i);
    if (!layout) throw unsupportedError("pipelineLayout", `Los grupos de bind deben ser contiguos para pipeline layout; falta group(${i}).`);
    layouts.push(layout);
  }
  return device.gpu.createPipelineLayout({ bindGroupLayouts: layouts });
}

function layoutEntry(binding: BindingInfo): Omit<GPUBindGroupLayoutEntry, "binding" | "visibility"> {
  const reflected = binding.bindingLayout;
  if (!reflected) throw unsupportedError("bindGroupLayout", `Binding '${binding.name}' no tiene bindingLayout reflejado.`);
  return reflectedToWebGPU(reflected);
}

function reflectedToWebGPU(layout: ReflectedBindingLayout): Omit<GPUBindGroupLayoutEntry, "binding" | "visibility"> {
  switch (layout.kind) {
    case "buffer": return { buffer: { ...layout.buffer } };
    case "sampler": return { sampler: { ...layout.sampler } };
    case "texture": return { texture: { ...layout.texture } };
    case "storageTexture": return { storageTexture: { ...layout.storageTexture as GPUStorageTextureBindingLayout } };
    case "externalTexture": return { externalTexture: {} };
  }
}

function visibilityForBinding(binding: BindingInfo): GPUShaderStageFlags {
  const stages = globalThis.GPUShaderStage as unknown as Record<string, number> | undefined;
  const vertex = stages?.VERTEX ?? 1;
  const fragment = stages?.FRAGMENT ?? 2;
  const compute = stages?.COMPUTE ?? 4;
  return binding.kind === "buffer" ? (vertex | fragment | compute) : (fragment | compute);
}

function isPlainValue(value: unknown): boolean {
  if (value === null) return true;
  if (typeof value !== "object") return true;
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer || Array.isArray(value)) return true;
  if (value instanceof Buffer || value instanceof Texture) return false;
  if ("gpu" in value as never || "bindGroup" in value as never || "createView" in value as never) return false;
  return true;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value) || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return false;
  if (value instanceof Buffer || value instanceof Texture) return false;
  return !("gpu" in value as never) && !("bindGroup" in value as never) && !("createView" in value as never);
}

function normalizeResource(value: unknown): { readonly resource: GPUBindingResource; readonly identity: BindGroupIdentityPart; readonly unsubscribe?: (cb: () => void) => UnsubscribeResourceDestroy } {
  if (value instanceof Buffer) return { resource: { buffer: value.gpu }, identity: value.resourceIdentity, unsubscribe: (cb) => value.onDestroy(cb) };
  if (value instanceof Texture) return { resource: value.createView(), identity: value.resourceIdentity, unsubscribe: (cb) => value.onDestroy(cb) };
  if (isUniformLike(value)) return { resource: { buffer: value.gpu, offset: 0, size: value.size }, identity: value.buffer.resourceIdentity, unsubscribe: (cb) => value.buffer.onDestroy(cb) };
  if (isTextureLike(value)) return { resource: value.createView(), identity: value.resourceIdentity ?? syntheticIdentity(value) };
  if (isSampler(value)) return { resource: value, identity: syntheticIdentity(value) };
  if (isGPUBufferBinding(value)) return { resource: value, identity: syntheticIdentity(value.buffer) };
  if (isRawGPUBuffer(value)) return { resource: { buffer: value }, identity: syntheticIdentity(value) };
  return { resource: value as GPUBindingResource, identity: syntheticIdentity(value) };
}

const syntheticIds = new WeakMap<object, BindGroupIdentityPart>();
function syntheticIdentity(value: unknown): BindGroupIdentityPart {
  if (typeof value !== "object" || value === null) return `value:${String(value)}`;
  let id = syntheticIds.get(value);
  if (!id) {
    id = { kind: "external", id: nextSyntheticResourceId++ };
    syntheticIds.set(value, id);
  }
  return id;
}

function isUniformLike(value: unknown): value is { readonly gpu: GPUBuffer; readonly size: number; readonly buffer: Buffer } {
  return typeof value === "object" && value !== null && "gpu" in value && "size" in value && "buffer" in value && (value as { buffer?: unknown }).buffer instanceof Buffer;
}
function isTextureLike(value: unknown): value is { createView(desc?: GPUTextureViewDescriptor): GPUTextureView; readonly resourceIdentity?: ResourceIdentity } {
  return typeof value === "object" && value !== null && typeof (value as { createView?: unknown }).createView === "function";
}
function isSampler(value: unknown): value is GPUSampler {
  return typeof value === "object" && value !== null && !isRawGPUBuffer(value) && !isGPUBufferBinding(value) && !isTextureLike(value);
}
function isGPUBufferBinding(value: unknown): value is GPUBufferBinding {
  return typeof value === "object" && value !== null && "buffer" in value && isRawGPUBuffer((value as GPUBufferBinding).buffer);
}
function isRawGPUBuffer(value: unknown): value is GPUBuffer {
  return typeof value === "object" && value !== null && "size" in value && "usage" in value && typeof (value as GPUBuffer).destroy === "function";
}

export function writeLayoutValue(layout: HostShareableLayout, value: unknown): ArrayBuffer {
  if (layout.size === undefined) throw unsupportedError("set", `No se puede inferir byteLength para layout runtime-sized '${layout.name}'.`);
  const buffer = new ArrayBuffer(layout.size);
  writeValue(new DataView(buffer), layout, 0, value);
  return buffer;
}

function writeValue(view: DataView, layout: HostShareableLayout, offset: number, value: unknown): void {
  if (layout.members) {
    const object = value as Record<string, unknown>;
    for (const member of layout.members) writeMember(view, member, offset, object?.[member.name]);
    return;
  }
  switch (layout.type.kind) {
    case "scalar": writeScalar(view, offset, layout.type.name, value); return;
    case "vector": writeVector(view, offset, layout.type, value); return;
    case "matrix": writeMatrix(view, layout, offset, value); return;
    case "array": writeArray(view, layout, offset, value); return;
    default: throw unsupportedError("set", `No hay writer para layout ${layout.type.kind}.`);
  }
}
function writeMember(view: DataView, member: LayoutMember, base: number, value: unknown): void { writeValue(view, member.layout, base + member.offset, value); }
function writeScalar(view: DataView, offset: number, type: "f32" | "f16" | "i32" | "u32" | "bool", value: unknown): void {
  if (type === "f32") view.setFloat32(offset, Number(value ?? 0), true);
  else if (type === "i32") view.setInt32(offset, Number(value ?? 0), true);
  else if (type === "u32" || type === "bool") view.setUint32(offset, type === "bool" ? (value ? 1 : 0) : Number(value ?? 0), true);
  else view.setUint16(offset, float32ToFloat16(Number(value ?? 0)), true);
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
  const values = value as readonly unknown[];
  const stride = layout.stride ?? layout.element?.size ?? 0;
  if (!layout.element) throw unsupportedError("set", "Array layout sin element layout.");
  for (let i = 0; i < (values?.length ?? 0); i++) writeValue(view, layout.element, offset + i * stride, values[i]);
}
function scalarByteSize(type: WGSLType): number { return scalarName(type) === "f16" ? 2 : 4; }
function scalarName(type: WGSLType): "f32" | "f16" | "i32" | "u32" | "bool" { if (type.kind !== "scalar") throw unsupportedError("set", `Expected scalar, got ${type.kind}`); return type.name; }
function float32ToFloat16(value: number): number {
  const float = new Float32Array(1), int = new Uint32Array(float.buffer); float[0] = value; const x = int[0]!;
  const sign = (x >> 16) & 0x8000, mantissa = x & 0x007fffff, exponent = (x >> 23) & 0xff;
  if (exponent === 0xff) return sign | (mantissa ? 0x7e00 : 0x7c00);
  const halfExponent = exponent - 127 + 15;
  if (halfExponent >= 0x1f) return sign | 0x7c00;
  if (halfExponent <= 0) return halfExponent < -10 ? sign : sign | ((mantissa | 0x00800000) >> (1 - halfExponent + 13));
  return sign | (halfExponent << 10) | (mantissa >> 13);
}
