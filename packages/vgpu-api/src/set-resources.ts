import { Buffer, Texture, type ResourceIdentity, type UnsubscribeResourceDestroy } from "@vgpu/core";
import type { BindGroupIdentityPart } from "./bind-cache.ts";

export interface NormalizedBindingResource {
  readonly resource: GPUBindingResource;
  readonly identity: BindGroupIdentityPart;
  readonly unsubscribe?: (cb: () => void) => UnsubscribeResourceDestroy;
}

let nextSyntheticResourceId = 1;
const syntheticIds = new WeakMap<object, BindGroupIdentityPart>();

export function isPlainValue(value: unknown): boolean {
  if (value === null) return true;
  if (typeof value !== "object") return true;
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer || Array.isArray(value)) return true;
  if (value instanceof Buffer || value instanceof Texture) return false;
  if ("gpu" in value as never || "bindGroup" in value as never || "createView" in value as never) return false;
  return true;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value) || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return false;
  if (value instanceof Buffer || value instanceof Texture) return false;
  return !("gpu" in value as never) && !("bindGroup" in value as never) && !("createView" in value as never);
}

/** Normalizes ring-0 and native WebGPU resources into bind-group resources plus stable cache identities. */
export function normalizeResource(value: unknown): NormalizedBindingResource {
  if (value instanceof Buffer) return { resource: { buffer: value.gpu }, identity: value.resourceIdentity, unsubscribe: (cb) => value.onDestroy(cb) };
  if (value instanceof Texture) return { resource: value.createView(), identity: value.resourceIdentity, unsubscribe: (cb) => value.onDestroy(cb) };
  if (isUniformLike(value)) return { resource: { buffer: value.gpu, offset: 0, size: value.size }, identity: value.buffer.resourceIdentity, unsubscribe: (cb) => value.buffer.onDestroy(cb) };
  if (isTextureLike(value)) return { resource: value.createView(), identity: value.resourceIdentity ?? syntheticIdentity(value) };
  if (isSampler(value)) return { resource: value, identity: syntheticIdentity(value) };
  if (isGPUBufferBinding(value)) return { resource: value, identity: syntheticIdentity(value.buffer) };
  if (isRawGPUBuffer(value)) return { resource: { buffer: value }, identity: syntheticIdentity(value) };
  return { resource: value as GPUBindingResource, identity: syntheticIdentity(value) };
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
function isSampler(value: unknown): value is GPUSampler {
  return typeof value === "object" && value !== null && !isRawGPUBuffer(value) && !isGPUBufferBinding(value) && !isTextureLike(value);
}
function isGPUBufferBinding(value: unknown): value is GPUBufferBinding {
  return typeof value === "object" && value !== null && "buffer" in value && isRawGPUBuffer((value as GPUBufferBinding).buffer);
}
function isRawGPUBuffer(value: unknown): value is GPUBuffer {
  return typeof value === "object" && value !== null && "size" in value && "usage" in value && typeof (value as GPUBuffer).destroy === "function";
}
