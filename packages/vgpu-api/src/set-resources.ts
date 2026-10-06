import type { UniformValue } from "./frame-uniforms.ts";
import { Buffer, Texture, type Device, type ResourceIdentity, type UnsubscribeResourceDestroy } from "@vgpu/core";
import type { BindingInfo } from "@vgpu/wgsl/reflect-source";
import { identityKey, type BindGroupIdentityPart } from "./bind-cache.ts";
import { destroyedBindingError, incompatibleResourceError, surfaceNotBindableError, textureFilterabilityError } from "./errors.ts";
import type { Target } from "./target.ts";
import { assertBufferUsable } from "./lifecycle.ts";
import { BINDING_RESOURCE, bindingResourceOf, isSurfaceTarget } from "./draw-protocols.ts";
import { bindingTextureView } from "./binding-views.ts";

export interface NormalizedBindingResource {
  readonly uniformValue?: () => UniformValue;
  /** Flush the stable uniform buffer; retain=true keeps future updates live for raw/bundle consumers. */
  readonly prepareUniform?: (retain: boolean) => void;
  readonly resourceLabel?: string;
  readonly resource: GPUBindingResource;
  readonly identity: BindGroupIdentityPart;
  readonly cacheIdentity?: BindGroupIdentityPart;
  readonly underlyingBuffer?: GPUBuffer;
  readonly tracked?: readonly TrackedBindingResource[];
  readonly followedTarget?: FollowedTargetBinding;
}

export interface TrackedBindingResource {
  readonly resource: object;
  readonly identity: BindGroupIdentityPart;
  readonly subscribe: (cb: () => void) => UnsubscribeResourceDestroy;
}

export interface FollowedTargetBinding {
  readonly target: Target;
  readonly depth: boolean;
}

export interface ResourceNormalizationContext {
  readonly device: Device;
  readonly cache: import("./bind-cache.ts").BindGroupCache;
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
  if (bindingResourceOf(value)) return false;
  if (isRawGPUBuffer(value) || isGPUBufferBinding(value)) return false;
  return !hasAnyResourceShape(value);
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value) || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return false;
  if (value instanceof Buffer || value instanceof Texture) return false;
  if (bindingResourceOf(value)) return false;
  if (isRawGPUBuffer(value) || isGPUBufferBinding(value)) return false;
  return !hasAnyResourceShape(value);
}

/** Normalizes resources for the reflected binding kind and rejects incompatible values with vgpu fix-its. */
export function normalizeResource(binding: BindingInfo, value: unknown, context: ResourceNormalizationContext): NormalizedBindingResource {
  assertResourceBindable(binding, value, context.sourceHint);
  try { return normalizeLiveResource(binding, value, context); }
  catch (error) {
    const code = (error as { code?: string })?.code;
    if (code === "VGPU-CORE-TEXTURE-DESTROYED" || code === "VGPU-BUFFER-DISPOSED") {
      const label = code === "VGPU-BUFFER-DISPOSED" ? trackedBufferLabel(value) : value instanceof Texture ? value.label : asTarget(value)?.color.label;
      throw destroyedBindingError(context.sourceHint, binding, label);
    }
    throw error;
  }
}

function normalizeLiveResource(binding: BindingInfo, value: unknown, context: ResourceNormalizationContext): NormalizedBindingResource {
  assertResourceBindable(binding, value, context.sourceHint);
  switch (binding.bindingLayout?.kind) {
    case "buffer": return normalizeBufferResource(binding, value, context);
    case "texture": return normalizeTextureResource(binding, value, context);
    case "sampler": return normalizeSamplerResource(binding, value);
    case "storageTexture": return normalizeStorageTextureResource(binding, value, context);
    case "externalTexture": throw incompatibleResourceError(binding, "external texture", "Pass a compatible GPUExternalTexture.");
    default: throw incompatibleResourceError(binding, "reflected resource", "Fix shader reflection bindingLayout.");
  }
}

export function assertResourceBindable(binding: BindingInfo, value: unknown, label: string): void {
  if (isSurfaceTarget(value)) throw surfaceNotBindableError(label, binding);
}

function normalizeBufferResource(binding: BindingInfo, value: unknown, context: ResourceNormalizationContext): NormalizedBindingResource {
  // Nominal protocol, not an instanceof: recognizing a shared uniforms block must not link it.
  const provider = bindingResourceOf(value);
  if (provider) return normalizeBufferBinding(binding, provider[BINDING_RESOURCE](binding, context.sourceHint), context);
  if (value instanceof Buffer) {
    assertBufferUsable(value, `${context.sourceHint}.set`);
    return normalizeBufferBinding(binding, {
      resourceLabel: value.options.label ?? value.gpu.label,
      resource: { buffer: value.gpu },
      identity: value.resourceIdentity,
      tracked: [trackedResource(value, value.resourceIdentity)],
    }, context);
  }
  if (isUniformLike(value)) {
    assertBufferUsable(value.buffer, `${context.sourceHint}.set`);
    return normalizeBufferBinding(binding, {
      resourceLabel: value.buffer.options.label ?? value.buffer.gpu.label,
      resource: { buffer: value.gpu, offset: 0, size: value.size },
      identity: value.buffer.resourceIdentity,
      tracked: [trackedResource(value.buffer, value.buffer.resourceIdentity)],
    }, context);
  }
  if (isGPUBufferBinding(value)) return normalizeBufferBinding(binding, { resource: value, identity: syntheticIdentity(value.buffer) }, context);
  if (isRawGPUBuffer(value)) return normalizeBufferBinding(binding, { resource: { buffer: value }, identity: syntheticIdentity(value) }, context);
  throw incompatibleResourceError(binding, "buffer", `Pass a compatible Buffer/Uniform: ${binding.name}.set({ ${binding.name}: gpu.device.createBuffer(...) }).`);
}

function normalizeBufferBinding(binding: BindingInfo, normalized: NormalizedBindingResource, context: ResourceNormalizationContext): NormalizedBindingResource {
  if (!isGPUBufferBinding(normalized.resource)) return normalized;
  const { buffer } = normalized.resource;
  const offset = normalized.resource.offset === undefined ? 0 : normalized.resource.offset;
  const size = normalized.resource.size === undefined ? buffer.size - offset : normalized.resource.size;
  validateBufferRange(binding, buffer, offset, size, context.device.limits, normalized.tracked !== undefined);
  return {
    ...normalized,
    resource: { buffer, offset, size },
    identity: bufferRangeIdentity(buffer, offset, size),
    underlyingBuffer: buffer,
  };
}

function validateBufferRange(binding: BindingInfo, buffer: GPUBuffer, offset: number, size: number, limits: GPUSupportedLimits, tracked: boolean): void {
  const layout = binding.bindingLayout?.kind === "buffer" ? binding.bindingLayout.buffer : undefined;
  const storage = layout?.type === "storage" || layout?.type === "read-only-storage";
  const usageName = storage ? "storage" : "uniform";
  const usageFlag = globalThis.GPUBufferUsage?.[storage ? "STORAGE" : "UNIFORM"] ?? (storage ? 0x80 : 0x40);
  const alignment = storage ? limits.minStorageBufferOffsetAlignment : limits.minUniformBufferOffsetAlignment;
  const maximum = storage ? limits.maxStorageBufferBindingSize : limits.maxUniformBufferBindingSize;
  const minimum = Math.max(layout?.minBindingSize ?? 0, binding.layout?.size ?? 0);
  const fix = `Create the buffer with ${usageName} usage and use a safe integer offset aligned to ${alignment} bytes plus a positive size from ${Math.max(1, minimum)} to ${maximum} bytes within buffer.size.`;
  const reject = (reason: string): never => { throw incompatibleResourceError(binding, `a valid ${usageName} buffer range (${reason})`, fix); };

  if ((buffer.usage & usageFlag) === 0) {
    const usageFix = tracked ? `Create with usage: ['${usageName}','copy_dst'].` : fix;
    throw incompatibleResourceError(binding, `a valid ${usageName} buffer range (buffer usage is missing ${usageName})`, usageFix);
  }
  if (!Number.isFinite(offset) || !Number.isSafeInteger(offset) || offset < 0) reject("offset must be a non-negative safe integer");
  if (!Number.isFinite(size) || !Number.isSafeInteger(size) || size <= 0) reject("size must be a positive safe integer");
  if (offset > buffer.size) reject("offset exceeds buffer.size");
  if (size > buffer.size - offset) reject("offset + size exceeds buffer.size");
  if (offset % alignment !== 0) reject(`offset must be aligned to ${alignment} bytes`);
  if (size < minimum) reject(`size is below the reflected minimum of ${minimum} bytes`);
  if (size > maximum) reject(`size exceeds the granted maximum of ${maximum} bytes`);
  if (storage && size % 4 !== 0) reject("storage size must be a multiple of 4 bytes");
}

function bufferRangeIdentity(buffer: GPUBuffer, offset: number, size: number): string {
  return `buffer-range:${JSON.stringify([identityKey(syntheticIdentity(buffer)), offset, size])}`;
}

function normalizeTextureResource(binding: BindingInfo, value: unknown, context: ResourceNormalizationContext): NormalizedBindingResource {
  const depthBinding = binding.bindingLayout?.kind === "texture" && binding.bindingLayout.texture.sampleType === "depth";
  const target = asTarget(value);
  if (target) {
    // A depth binding takes the target's depth attachment; everything else takes its first color.
    if (depthBinding && !target.depth) throw incompatibleResourceError(binding, "a target with a depth attachment", `Create it with target(gpu, { size, depth: true }) or bind a Texture: set({ ${binding.name}: scene.depth }).`);
    const texture = depthBinding ? target.depth! : target.color;
    validateTextureFilterability(binding, texture, context);
    const bound = bindingTextureView(texture, textureViewDescriptor(texture), context.cache, context.device);
    return {
      resourceLabel: texture.label,
      resource: bound.view,
      identity: texture.resourceIdentity,
      cacheIdentity: textureViewIdentity(texture.resourceIdentity, bound.key),
      tracked: [trackedResource(target, target.resourceIdentity), trackedResource(texture, texture.resourceIdentity)],
      followedTarget: { target, depth: depthBinding },
    };
  }
  if (value instanceof Texture) {
    validateTextureUsage(binding, value.usage);
    validateTextureFilterability(binding, value, context);
    const bound = bindingTextureView(value, textureViewDescriptor(value), context.cache, context.device);
    return { resourceLabel: value.label, resource: bound.view, identity: value.resourceIdentity, cacheIdentity: textureViewIdentity(value.resourceIdentity, bound.key), tracked: [trackedResource(value, value.resourceIdentity)] };
  }
  if (isTextureLike(value)) return { resource: value.createView(), identity: value.resourceIdentity ?? syntheticIdentity(value) };
  if (typeof value === "object" && value !== null) return { resource: value as GPUTextureView, identity: syntheticIdentity(value) };
  throw incompatibleResourceError(binding, "texture/target", `Pass a Texture or Target: ${binding.name}.set({ ${binding.name}: scene.color }) or set({ ${binding.name}: scene }).`);
}

function normalizeStorageTextureResource(binding: BindingInfo, value: unknown, context: ResourceNormalizationContext): NormalizedBindingResource {
  const layout = binding.bindingLayout?.kind === "storageTexture" ? binding.bindingLayout.storageTexture : undefined;
  const expected: ExpectedStorageTexture = { format: layout?.format as GPUTextureFormat | undefined, viewDimension: (layout?.viewDimension ?? "2d") as GPUTextureViewDimension };
  const create = `texture(gpu, { kind: "${expected.viewDimension}", size${expected.viewDimension === "2d-array" ? ", layers" : ""}, format: "${expected.format ?? "rgba8unorm"}", usage: ["storage_binding"] })`;
  if (asTarget(value)) throw incompatibleResourceError(binding, "a storage texture, not a Target", `Render targets are not storage textures. Create one with ${create} and set({ ${binding.name}: texture }).`);
  if (value instanceof Texture) {
    validateStorageTexture(binding, value, expected, create);
    const bound = bindingTextureView(value, storageViewDescriptor(expected.viewDimension), context.cache, context.device);
    return { resourceLabel: value.label, resource: bound.view, identity: value.resourceIdentity, cacheIdentity: textureViewIdentity(value.resourceIdentity, bound.key), tracked: [trackedResource(value, value.resourceIdentity)] };
  }
  if (isTextureLike(value)) return { resource: value.createView(storageViewDescriptor(expected.viewDimension)), identity: value.resourceIdentity ?? syntheticIdentity(value) };
  if (typeof value === "object" && value !== null) return { resource: value as GPUTextureView, identity: syntheticIdentity(value) };
  throw incompatibleResourceError(binding, "a storage texture", `Pass a Texture from ${create}: set({ ${binding.name}: texture }).`);
}

interface ExpectedStorageTexture { readonly format?: GPUTextureFormat; readonly viewDimension: GPUTextureViewDimension }

function validateStorageTexture(binding: BindingInfo, texture: Texture, expected: ExpectedStorageTexture, create: string): void {
  const name = texture.label ?? "texture";
  if (!texture.usage.includes("storage_binding")) throw incompatibleResourceError(binding, "a texture with storage_binding usage", `Create it with ${create}; include texture_binding too if you also sample it.`);
  if (expected.format && texture.format !== expected.format) {
    throw incompatibleResourceError(binding, `format ${expected.format}`, `Texture '${name}' is ${texture.format}. Create it with ${create} or declare texture_storage_${expected.viewDimension.replace("-", "_")}<${texture.format}, ...> in WGSL.`);
  }
  const dimension = textureDimensionFor(expected.viewDimension);
  if (dimension && texture.dimension !== dimension) throw incompatibleResourceError(binding, `dimension "${dimension}"`, `Texture '${name}' has kind "${texture.kind}". Create it with ${create}.`);
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

function trackedResource(
  resource: { onDestroy(cb: () => void): UnsubscribeResourceDestroy },
  identity: BindGroupIdentityPart,
): TrackedBindingResource {
  return { resource, identity, subscribe: (callback) => resource.onDestroy(callback) };
}

function trackedBufferLabel(value: unknown): string | undefined {
  try {
    const buffer = value instanceof Buffer
      ? value
      : typeof value === "object" && value !== null && "buffer" in value
        ? (value as { readonly buffer?: unknown }).buffer
        : undefined;
    return buffer instanceof Buffer ? buffer.options.label ?? buffer.gpu.label : undefined;
  } catch { return undefined; }
}

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

function textureViewIdentity(identity: BindGroupIdentityPart, key: string): string {
  return `texture-view:${JSON.stringify([identityKey(identity), key])}`;
}

function isUniformLike(value: unknown): value is { readonly gpu: GPUBuffer; readonly size: number; readonly buffer: Buffer } {
  return typeof value === "object" && value !== null && "gpu" in value && "size" in value && "buffer" in value && (value as { buffer?: unknown }).buffer instanceof Buffer;
}
function isTextureLike(value: unknown): value is { createView(desc?: GPUTextureViewDescriptor): GPUTextureView; readonly resourceIdentity?: ResourceIdentity } {
  return typeof value === "object" && value !== null && typeof (value as { createView?: unknown }).createView === "function";
}
export function isGPUBufferBinding(value: unknown): value is GPUBufferBinding {
  return typeof value === "object" && value !== null && "buffer" in value && isRawGPUBuffer((value as GPUBufferBinding).buffer);
}
export function isRawGPUBuffer(value: unknown): value is GPUBuffer {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<GPUBuffer>;
  return Number.isSafeInteger(candidate.size) && candidate.size! >= 0
    && typeof candidate.usage === "number"
    && typeof candidate.destroy === "function"
    && typeof candidate.mapAsync === "function"
    && typeof candidate.getMappedRange === "function"
    && typeof candidate.unmap === "function";
}
