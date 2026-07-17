import { Buffer, Texture, type ResourceIdentity, type UnsubscribeResourceDestroy } from "@vgpu/core";
import type { BindingInfo } from "@vgpu/wgsl/reflect-source";
import type { BindGroupIdentityPart } from "./bind-cache.ts";
import { incompatibleResourceError } from "./errors.ts";
import type { Target } from "./target.ts";
import { isSharedUniformsValue } from "./uniforms.ts";

export interface NormalizedBindingResource {
  readonly resource: GPUBindingResource;
  readonly identity: BindGroupIdentityPart;
  readonly unsubscribe?: (cb: () => void) => UnsubscribeResourceDestroy;
  readonly onRecreate?: (cb: () => void) => () => void;
}

export interface ResourceNormalizationContext {
  readonly sourceHint: string;
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
    case "texture": return normalizeTextureResource(binding, value);
    case "sampler": return normalizeSamplerResource(binding, value);
    case "storageTexture": throw incompatibleResourceError(binding, "storage texture", "Pasá una textura storage-compatible; Lane C congela el helper storage texture.");
    case "externalTexture": throw incompatibleResourceError(binding, "external texture", "Pasá un GPUExternalTexture compatible con el binding reflejado.");
    default: throw incompatibleResourceError(binding, "recurso reflejado", "La reflection no expuso bindingLayout para validar este recurso.");
  }
}

function normalizeBufferResource(binding: BindingInfo, value: unknown, context: ResourceNormalizationContext): NormalizedBindingResource {
  if (isSharedUniformsValue(value)) return value.asBindingResource(binding, context.sourceHint);
  if (value instanceof Buffer) {
    validateBufferUsage(binding, value.options.usage);
    return { resource: { buffer: value.gpu }, identity: value.resourceIdentity, unsubscribe: (cb) => value.onDestroy(cb) };
  }
  if (isUniformLike(value)) return { resource: { buffer: value.gpu, offset: 0, size: value.size }, identity: value.buffer.resourceIdentity, unsubscribe: (cb) => value.buffer.onDestroy(cb) };
  if (isGPUBufferBinding(value)) return { resource: value, identity: syntheticIdentity(value.buffer) };
  if (isRawGPUBuffer(value)) return { resource: { buffer: value }, identity: syntheticIdentity(value) };
  throw incompatibleResourceError(binding, "buffer", `Pasá un Buffer/Uniform compatible: ${binding.name}.set({ ${binding.name}: gpu.device.createBuffer(...) }).`);
}

function normalizeTextureResource(binding: BindingInfo, value: unknown): NormalizedBindingResource {
  const target = asTarget(value);
  if (target) {
    const color = target.color;
    const onTexturesRecreated = target.onTexturesRecreated?.bind(target);
    return { resource: color.createView(), identity: color.resourceIdentity, unsubscribe: (cb) => target.onDestroy(cb), onRecreate: onTexturesRecreated ? (cb) => onTexturesRecreated(cb) : undefined };
  }
  if (value instanceof Texture) {
    validateTextureUsage(binding, value.usage);
    return { resource: value.createView(), identity: value.resourceIdentity, unsubscribe: (cb) => value.onDestroy(cb) };
  }
  if (isTextureLike(value)) return { resource: value.createView(), identity: value.resourceIdentity ?? syntheticIdentity(value) };
  throw incompatibleResourceError(binding, "texture/target", `Pasá una Texture o Target: ${binding.name}.set({ ${binding.name}: scene.color }) o set({ ${binding.name}: scene }).`);
}

function normalizeSamplerResource(binding: BindingInfo, value: unknown): NormalizedBindingResource {
  if (isSamplerLike(value)) return { resource: value, identity: syntheticIdentity(value) };
  throw incompatibleResourceError(binding, "sampler", `Usá el sampler cacheado: set({ ${binding.name}: gpu.sampler() }).`);
}

function isSamplerLike(value: unknown): value is GPUSampler {
  if (typeof value !== "object" || value === null) return false;
  if (value instanceof Buffer || value instanceof Texture) return false;
  return !isRawGPUBuffer(value) && !isGPUBufferBinding(value) && !isTextureLike(value) && !asTarget(value);
}

function validateBufferUsage(binding: BindingInfo, usage: readonly string[]): void {
  const expected = binding.bindingLayout?.kind === "buffer" ? binding.bindingLayout.buffer.type : undefined;
  if (expected === "uniform" && !usage.includes("uniform")) throw incompatibleResourceError(binding, "uniform buffer", "Creá el buffer con usage: ['uniform', 'copy_dst'].");
  if ((expected === "storage" || expected === "read-only-storage") && !usage.includes("storage")) throw incompatibleResourceError(binding, "storage buffer", "Creá el buffer con usage: ['storage', 'copy_dst'].");
}

function validateTextureUsage(binding: BindingInfo, usage: readonly string[]): void {
  if (!usage.includes("texture_binding") && !usage.includes("render_attachment")) {
    throw incompatibleResourceError(binding, "sampled texture", "Creá la textura con usage: ['texture_binding'] o pasá un Target/color texture sampleable.");
  }
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
