import { Buffer, Texture, type ResourceIdentity, type UnsubscribeResourceDestroy } from "@vgpu/core";
import type { BindingInfo } from "@vgpu/wgsl/reflect-source";
import type { BindGroupIdentityPart } from "./bind-cache.ts";
import { incompatibleResourceError, textureFilterabilityError } from "./errors.ts";
import type { Target } from "./target.ts";
import { assertBufferUsable } from "./lifecycle.ts";
import { BINDING_RESOURCE, bindingResourceOf } from "./draw-protocols.ts";

export interface NormalizedBindingResource {
  readonly resource: GPUBindingResource;
  readonly identity: BindGroupIdentityPart;
  readonly unsubscribe?: (cb: () => void) => UnsubscribeResourceDestroy;
  readonly onRecreate?: (cb: () => void) => () => void;
}

export interface ResourceNormalizationContext {
  readonly sourceHint: string;
  readonly filterableTexture?: boolean;
  readonly float32Filterable?: boolean;
  readonly pairedSampler?: BindingInfo;
}

type ObjectRecord = Record<PropertyKey, unknown>;

let nextSyntheticResourceId = 1;
const syntheticIds = new WeakMap<object, BindGroupIdentityPart>();

export function isPlainValue(value: unknown): boolean {
  if (value === null) return true;
  if (typeof value !== "object") return true;
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer || Array.isArray(value)) return true;
  if (value instanceof Buffer || value instanceof Texture) return false;
  return !hasAnyResourceShape(value);
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value) || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return false;
  if (value instanceof Buffer || value instanceof Texture) return false;
  return !hasAnyResourceShape(value);
}

/** Normalizes resources for the reflected binding kind and rejects incompatible values with vgpu fix-its. */
export function normalizeResource(binding: BindingInfo, value: unknown, context: ResourceNormalizationContext): NormalizedBindingResource {
  switch (binding.bindingLayout?.kind) {
    case "buffer": return normalizeBufferResource(binding, value, context);
    case "texture": return normalizeTextureResource(binding, value, context);
    case "sampler": return normalizeSamplerResource(binding, value);
    case "storageTexture": return normalizeStorageTextureResource(binding, value);
    case "externalTexture": throw incompatibleResourceError(binding, "external texture", "Pass a compatible GPUExternalTexture.");
    default: throw incompatibleResourceError(binding, "reflected resource", "Fix shader reflection bindingLayout.");
  }
}

function normalizeBufferResource(binding: BindingInfo, value: unknown, context: ResourceNormalizationContext): NormalizedBindingResource {
  // Nominal protocol, not an instanceof: recognizing a shared uniforms block must not link it.
  const provider = bindingResourceOf(value);
  if (provider) return provider[BINDING_RESOURCE](binding, context.sourceHint);
  if (value instanceof Buffer) {
    assertBufferUsable(value, `${context.sourceHint}.set`);
    validateBufferUsage(binding, value.options.usage);
    return { resource: { buffer: value.gpu }, identity: value.resourceIdentity, unsubscribe: (cb) => value.onDestroy(cb) };
  }
  if (isUniformLike(value)) {
    assertBufferUsable(value.buffer, `${context.sourceHint}.set`);
    return { resource: { buffer: value.gpu, offset: 0, size: value.size }, identity: value.buffer.resourceIdentity, unsubscribe: (cb) => value.buffer.onDestroy(cb) };
  }
  if (isGPUBufferBinding(value)) return { resource: value, identity: syntheticIdentity(value.buffer) };
  if (isRawGPUBuffer(value)) return { resource: { buffer: value }, identity: syntheticIdentity(value) };
  throw incompatibleResourceError(binding, "buffer", `Pass a compatible Buffer/Uniform: ${binding.name}.set({ ${binding.name}: gpu.device.createBuffer(...) }).`);
}

function normalizeTextureResource(binding: BindingInfo, value: unknown, context: ResourceNormalizationContext): NormalizedBindingResource {
  const depthBinding = binding.bindingLayout?.kind === "texture" && binding.bindingLayout.texture.sampleType === "depth";
  const target = asTarget(value);
  if (target) {
    // A depth binding takes the target's depth attachment; everything else takes its first color.
    if (depthBinding && !target.depth) throw incompatibleResourceError(binding, "a target with a depth attachment", `Create it with target(gpu, { size, depth: true }) or bind a Texture: set({ ${binding.name}: scene.depth }).`);
    const texture = depthBinding ? target.depth! : target.color;
    validateTextureFilterability(binding, texture, context);
    const onTexturesRecreated = target.onTexturesRecreated?.bind(target);
    return { resource: texture.createView(textureViewDescriptor(texture)), identity: texture.resourceIdentity, unsubscribe: (cb) => target.onDestroy(cb), onRecreate: onTexturesRecreated ? (cb) => onTexturesRecreated(cb) : undefined };
  }
  if (value instanceof Texture) {
    validateTextureUsage(binding, value.usage);
    validateTextureFilterability(binding, value, context);
    return { resource: value.createView(textureViewDescriptor(value)), identity: value.resourceIdentity, unsubscribe: (cb) => value.onDestroy(cb) };
  }
  if (isTextureLike(value)) return { resource: value.createView(), identity: value.resourceIdentity ?? syntheticIdentity(value) };
  if (typeof value === "object" && value !== null) return { resource: value as GPUTextureView, identity: syntheticIdentity(value) };
  throw incompatibleResourceError(binding, "texture/target", `Pass a Texture or Target: ${binding.name}.set({ ${binding.name}: scene.color }) or set({ ${binding.name}: scene }).`);
}

function normalizeStorageTextureResource(binding: BindingInfo, value: unknown): NormalizedBindingResource {
  const layout = binding.bindingLayout?.kind === "storageTexture" ? binding.bindingLayout.storageTexture : undefined;
  const expected: ExpectedStorageTexture = { format: layout?.format as GPUTextureFormat | undefined, viewDimension: (layout?.viewDimension ?? "2d") as GPUTextureViewDimension };
  const create = `texture(gpu, { size, format: "${expected.format ?? "rgba8unorm"}"${expected.viewDimension === "3d" ? ', dimension: "3d"' : ""} })`;
  if (asTarget(value)) throw incompatibleResourceError(binding, "a storage texture, not a Target", `Render targets are not storage textures. Create one with ${create} and set({ ${binding.name}: texture }).`);
  if (value instanceof Texture) {
    validateStorageTexture(binding, value, expected, create);
    return { resource: value.createView(storageViewDescriptor(expected.viewDimension)), identity: value.resourceIdentity, unsubscribe: (cb) => value.onDestroy(cb) };
  }
  if (isTextureLike(value)) return { resource: value.createView(storageViewDescriptor(expected.viewDimension)), identity: value.resourceIdentity ?? syntheticIdentity(value) };
  if (typeof value === "object" && value !== null) return { resource: value as GPUTextureView, identity: syntheticIdentity(value) };
  throw incompatibleResourceError(binding, "a storage texture", `Pass a Texture from ${create}: set({ ${binding.name}: texture }).`);
}

interface ExpectedStorageTexture { readonly format?: GPUTextureFormat; readonly viewDimension: GPUTextureViewDimension }

function validateStorageTexture(binding: BindingInfo, texture: Texture, expected: ExpectedStorageTexture, create: string): void {
  const name = texture.label ?? "texture";
  if (!texture.usage.includes("storage_binding")) throw incompatibleResourceError(binding, "a texture with storage_binding usage", `Create it with ${create} (usage defaults include storage_binding).`);
  if (expected.format && texture.format !== expected.format) {
    throw incompatibleResourceError(binding, `format ${expected.format}`, `Texture '${name}' is ${texture.format}. Create it with ${create} or declare texture_storage_${expected.viewDimension.replace("-", "_")}<${texture.format}, ...> in WGSL.`);
  }
  const dimension = textureDimensionFor(expected.viewDimension);
  if (dimension && texture.dimension !== dimension) throw incompatibleResourceError(binding, `dimension "${dimension}"`, `Texture '${name}' is "${texture.dimension}". Create it with texture(gpu, { ..., dimension: "${dimension}" }).`);
}

/** Storage bindings address exactly one mip level; WebGPU rejects views spanning several. */
function storageViewDescriptor(dimension: GPUTextureViewDimension): GPUTextureViewDescriptor {
  return { dimension, baseMipLevel: 0, mipLevelCount: 1 };
}

function textureDimensionFor(viewDimension: GPUTextureViewDimension): GPUTextureDimension | undefined {
  switch (viewDimension) {
    case "1d": return "1d";
    case "2d": case "2d-array": return "2d";
    case "3d": return "3d";
    default: return undefined;
  }
}

function normalizeSamplerResource(binding: BindingInfo, value: unknown): NormalizedBindingResource {
  if (isSamplerLike(value)) return { resource: value, identity: syntheticIdentity(value) };
  throw incompatibleResourceError(binding, "sampler", `Use the cached sampler: set({ ${binding.name}: sampler(gpu) }).`);
}

function isSamplerLike(value: unknown): value is GPUSampler {
  if (typeof value !== "object" || value === null) return false;
  if (value instanceof Buffer || value instanceof Texture) return false;
  return !isRawGPUBuffer(value) && !isGPUBufferBinding(value) && !isTextureLike(value) && !asTarget(value);
}

function validateBufferUsage(binding: BindingInfo, usage: readonly string[]): void {
  const expected = binding.bindingLayout?.kind === "buffer" ? binding.bindingLayout.buffer.type : undefined;
  if (expected === "uniform" && !usage.includes("uniform")) throw incompatibleResourceError(binding, "uniform buffer", "Create with usage: ['uniform','copy_dst'].");
  if ((expected === "storage" || expected === "read-only-storage") && !usage.includes("storage")) throw incompatibleResourceError(binding, "storage buffer", "Create with usage: ['storage','copy_dst'].");
}

function validateTextureUsage(binding: BindingInfo, usage: readonly string[]): void {
  if (!usage.includes("texture_binding") && !usage.includes("render_attachment")) {
    throw incompatibleResourceError(binding, "sampled texture", "Use texture_binding usage or a sampleable Target.");
  }
}

function validateTextureFilterability(binding: BindingInfo, texture: Texture, context: ResourceNormalizationContext): void {
  if (!context.filterableTexture || context.float32Filterable) return;
  if (texture.format === "r32float" || texture.format === "rg32float" || texture.format === "rgba32float") {
    throw textureFilterabilityError(context.sourceHint, binding, texture.format, texture.label ?? "texture", context.pairedSampler);
  }
}

/** Depth-stencil formats need a depth-only view to satisfy a texture_depth_* binding. */
function textureViewDescriptor(texture: Texture): GPUTextureViewDescriptor | undefined {
  return texture.format.includes("stencil") ? { aspect: "depth-only" } : undefined;
}

type RecreatingTarget = Target & { readonly onTexturesRecreated?: (cb: () => void) => () => void };

function asTarget(value: unknown): RecreatingTarget | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Partial<RecreatingTarget>;
  if (!record.resourceIdentity || !record.color || typeof record.onDestroy !== "function") return undefined;
  return record as RecreatingTarget;
}

function hasAnyResourceShape(value: object): boolean {
  const record = value as ObjectRecord;
  return "gpu" in record || "bindGroup" in record || "createView" in record || "resourceIdentity" in record;
}

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
function isGPUBufferBinding(value: unknown): value is GPUBufferBinding {
  return typeof value === "object" && value !== null && "buffer" in value && isRawGPUBuffer((value as GPUBufferBinding).buffer);
}
function isRawGPUBuffer(value: unknown): value is GPUBuffer {
  return typeof value === "object" && value !== null && "size" in value && "usage" in value && typeof (value as GPUBuffer).destroy === "function";
}
