import { Buffer } from "./buffer.ts";
import { Device } from "./device.ts";
import { ValidationError } from "./errors.ts";
import { Texture } from "./texture.ts";

export type BindVisibility = GPUShaderStageFlags | string | readonly ("vertex" | "fragment" | "compute")[];
export type DeviceLike = GPUDevice | Device | { readonly gpu: GPUDevice };

export interface CreateBindGroupLayoutOptions {
  readonly label?: string;
  readonly entries: readonly GPUBindGroupLayoutEntry[];
}

export interface CreatePipelineLayoutOptions {
  readonly label?: string;
  readonly bindGroups: readonly GPUBindGroupLayout[];
}

export interface CreateBindGroupOptions {
  readonly label?: string;
  readonly layout: GPUBindGroupLayout;
  readonly entries: readonly GPUBindGroupEntry[];
}

export function createBindGroupLayout(device: DeviceLike, opts: CreateBindGroupLayoutOptions): GPUBindGroupLayout {
  return unwrapDevice(device).createBindGroupLayout({ label: opts.label, entries: [...opts.entries] });
}

export function createPipelineLayout(device: DeviceLike, opts: CreatePipelineLayoutOptions): GPUPipelineLayout {
  return unwrapDevice(device).createPipelineLayout({ label: opts.label, bindGroupLayouts: [...opts.bindGroups] });
}

export function createBindGroup(device: DeviceLike, opts: CreateBindGroupOptions): GPUBindGroup {
  if (!opts.layout) {
    throw new ValidationError({
      code: "VGPU-CORE-BIND-GROUP-LAYOUT-REQUIRED",
      message: "createBindGroup requires an explicit layout. vgpu does not use layout: \"auto\" for bind groups.",
      where: "createBindGroup",
    });
  }
  return unwrapDevice(device).createBindGroup({ label: opts.label, layout: opts.layout, entries: [...opts.entries] });
}

export interface SamplerDescriptorWithSugar extends GPUSamplerDescriptor {
  /**
   * Expands to `magFilter` and `minFilter`, but not `mipmapFilter`.
   * Explicit raw `magFilter`/`minFilter` fields take precedence over this expansion.
   *
   * WebGPU requires `magFilter`, `minFilter`, and `mipmapFilter` to all be `"linear"`
   * when `maxAnisotropy > 1`. Because this sugar does not set `mipmapFilter`,
   * `{ filter: "linear", maxAnisotropy: 16 }` throws a `ValidationError`; spell
   * trilinear anisotropic sampling explicitly as
   * `{ filter: "linear", mipmapFilter: "linear", maxAnisotropy: 16 }`.
   */
  readonly filter?: "linear" | "nearest";
  /**
   * Expands to `addressModeU`, `addressModeV`, and `addressModeW`.
   * Explicit raw address mode fields take precedence over this expansion.
   *
   * Values map as: `"clamp"` → `"clamp-to-edge"`, `"repeat"` → `"repeat"`,
   * and `"mirror"` → `"mirror-repeat"`.
   */
  readonly wrap?: "clamp" | "repeat" | "mirror";
}

/**
 * Creates a WebGPU sampler from a raw `GPUSamplerDescriptor` plus vgpu sampler sugar.
 *
 * `filter` expands to `magFilter` and `minFilter` only; it does not set
 * `mipmapFilter`. `wrap` expands to `addressModeU`, `addressModeV`, and
 * `addressModeW` using vgpu shorthand values (`"clamp"`, `"repeat"`, `"mirror"`).
 *
 * Sugar expands first, then explicit raw WebGPU fields win per key. For example,
 * `{ filter: "linear", magFilter: "nearest" }` keeps `magFilter: "nearest"`
 * while using `minFilter: "linear"`; raw address mode fields similarly override
 * individual `wrap` axes. The sugar keys are stripped before calling WebGPU.
 *
 * Throws `ValidationError` when `filter` sugar is used with `maxAnisotropy > 1`
 * and the resulting descriptor does not explicitly set `magFilter`, `minFilter`,
 * and `mipmapFilter` to `"linear"`.
 */
export function createSampler(device: DeviceLike, descriptor: SamplerDescriptorWithSugar = {}): GPUSampler {
  return unwrapDevice(device).createSampler(expandSamplerDescriptor(descriptor));
}

const samplerWrapModes = {
  clamp: "clamp-to-edge",
  repeat: "repeat",
  mirror: "mirror-repeat",
} as const satisfies Record<NonNullable<SamplerDescriptorWithSugar["wrap"]>, GPUAddressMode>;

function expandSamplerDescriptor(descriptor: SamplerDescriptorWithSugar): GPUSamplerDescriptor {
  const { filter, wrap, ...raw } = descriptor;
  const expanded: GPUSamplerDescriptor = {
    ...(filter ? { magFilter: filter, minFilter: filter } : {}),
    ...(wrap
      ? {
          addressModeU: samplerWrapModes[wrap],
          addressModeV: samplerWrapModes[wrap],
          addressModeW: samplerWrapModes[wrap],
        }
      : {}),
    ...raw,
  };

  if (filter !== undefined && expanded.maxAnisotropy !== undefined && expanded.maxAnisotropy > 1 && !samplerDescriptorHasAllLinearFilters(expanded)) {
    throw new ValidationError({
      code: "VGPU-CORE-SAMPLER-ANISOTROPY-FILTERS",
      message:
        'createSampler requires magFilter, minFilter, and mipmapFilter to all be "linear" when maxAnisotropy > 1. The filter sugar only sets magFilter and minFilter; add mipmapFilter: "linear" explicitly for anisotropic sampling.',
      where: "createSampler",
    });
  }

  return expanded;
}

function samplerDescriptorHasAllLinearFilters(descriptor: GPUSamplerDescriptor): boolean {
  return descriptor.magFilter === "linear" && descriptor.minFilter === "linear" && descriptor.mipmapFilter === "linear";
}

export const bind = {
  uniform,
  storage,
  readonlyStorage,
  texture,
  storageTexture,
  sampler,
  resource,
} as const;

function uniform(binding: number, visibility: BindVisibility, opts: Omit<GPUBufferBindingLayout, "type"> = {}): GPUBindGroupLayoutEntry {
  return { binding: explicitBinding(binding), visibility: visibilityFlags(visibility), buffer: { ...opts, type: "uniform" } };
}

function storage(binding: number, visibility: BindVisibility, opts: Omit<GPUBufferBindingLayout, "type"> = {}): GPUBindGroupLayoutEntry {
  return { binding: explicitBinding(binding), visibility: visibilityFlags(visibility), buffer: { ...opts, type: "storage" } };
}

function readonlyStorage(binding: number, visibility: BindVisibility, opts: Omit<GPUBufferBindingLayout, "type"> = {}): GPUBindGroupLayoutEntry {
  return { binding: explicitBinding(binding), visibility: visibilityFlags(visibility), buffer: { ...opts, type: "read-only-storage" } };
}

function texture(binding: number, visibility: BindVisibility, opts: GPUTextureBindingLayout = {}): GPUBindGroupLayoutEntry {
  return { binding: explicitBinding(binding), visibility: visibilityFlags(visibility), texture: opts };
}

function storageTexture(binding: number, visibility: BindVisibility, opts: GPUStorageTextureBindingLayout): GPUBindGroupLayoutEntry {
  return { binding: explicitBinding(binding), visibility: visibilityFlags(visibility), storageTexture: opts };
}

function sampler(binding: number, visibility: BindVisibility, opts: GPUSamplerBindingLayout = {}): GPUBindGroupLayoutEntry {
  return { binding: explicitBinding(binding), visibility: visibilityFlags(visibility), sampler: opts };
}

function resource(binding: number, value: unknown): GPUBindGroupEntry {
  return { binding: explicitBinding(binding), resource: unwrapBindingResource(value) };
}

function unwrapDevice(device: DeviceLike): GPUDevice {
  return device instanceof Device ? device.gpu : "gpu" in device ? device.gpu : device;
}

function unwrapBindingResource(value: unknown): GPUBindingResource {
  if (value instanceof Buffer) return { buffer: value.gpu };
  if (value instanceof Texture) return value.createView();
  if (isVGPUTextureLike(value)) return value.createView();
  if (isGPUBufferBinding(value)) return value as GPUBufferBinding;
  if (isVGPUBufferLike(value)) return { buffer: value.gpu };
  if (isRawGPUBuffer(value)) return { buffer: value as GPUBuffer };
  return value as GPUBindingResource;
}

function isGPUBufferBinding(value: unknown): value is GPUBufferBinding {
  return isObject(value) && "buffer" in value;
}

function isRawGPUBuffer(value: unknown): value is GPUBuffer {
  return isObject(value) && "size" in value && "usage" in value && typeof value.destroy === "function";
}

function isVGPUBufferLike(value: unknown): value is { readonly gpu: GPUBuffer } {
  return isObject(value) && isRawGPUBuffer(value.gpu);
}

function isVGPUTextureLike(value: unknown): value is { createView(desc?: GPUTextureViewDescriptor): GPUTextureView } {
  return isObject(value) && typeof value.createView === "function" && "gpu" in value;
}

function explicitBinding(binding: number): number {
  if (!Number.isInteger(binding) || binding < 0) {
    throw new ValidationError({
      code: "VGPU-CORE-BINDING-INVALID",
      message: "Binding entries require an explicit non-negative integer binding number.",
      where: "bind",
    });
  }
  return binding;
}

function visibilityFlags(visibility: BindVisibility): GPUShaderStageFlags {
  if (typeof visibility === "number") return visibility;
  const names = typeof visibility === "string" ? visibility.split(/[|,\s]+/) : visibility;
  return names.reduce((flags, name) => flags | shaderStageFlag(name), 0) as GPUShaderStageFlags;
}

function shaderStageFlag(name: string): number {
  const key = name.trim().toLowerCase();
  const constants = globalThis.GPUShaderStage as unknown as Record<string, number> | undefined;
  const flags: Record<string, number> = { vertex: constants?.VERTEX ?? 1, fragment: constants?.FRAGMENT ?? 2, compute: constants?.COMPUTE ?? 4 };
  const flag = flags[key];
  if (!flag) throw new ValidationError({ code: "VGPU-CORE-VISIBILITY-INVALID", message: `Unknown shader stage visibility '${name}'.`, where: "bind" });
  return flag;
}

function isObject(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === "object" && value !== null;
}
