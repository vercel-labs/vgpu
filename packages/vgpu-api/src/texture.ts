import type { Device, Texture, TextureUsageName } from "@vgpu/core";
import { textureSizeRequiredError, textureStorageFormatError } from "./errors.ts";
import type { Gpu } from "./kernel.ts";
import { liveKernel, ownResource } from "./live-kernel.ts";

export type { TextureUsageName } from "@vgpu/core";

/** Options for `texture(gpu)`: a standalone sampled/storage texture that is not a render target. */
export interface TextureOptions {
  readonly size: readonly [width: number, height: number, depthOrArrayLayers?: number];
  readonly format: GPUTextureFormat;
  /** Defaults to `["texture_binding", "storage_binding", "copy_src", "copy_dst"]`. */
  readonly usage?: readonly TextureUsageName[];
  /** Defaults to `"2d"`; `"3d"` turns the third size entry into a depth instead of a layer count. */
  readonly dimension?: GPUTextureDimension;
  readonly mipLevelCount?: number;
  readonly label?: string;
}

const DEFAULT_USAGE: readonly TextureUsageName[] = ["texture_binding", "storage_binding", "copy_src", "copy_dst"];

/** Standalone sampled/storage texture owned by this gpu. */
export function texture(gpu: Gpu, opts: TextureOptions): Texture {
  const kernel = liveKernel(gpu, "texture");
  const created = createTexture(kernel.device, opts);
  return ownResource(kernel, created, (owned) => owned.destroy(), (cb) => { created.onDestroy(cb); });
}

/** Formats WebGPU accepts for `STORAGE_BINDING` without optional features. */
export const STORAGE_CAPABLE_FORMATS: ReadonlySet<GPUTextureFormat> = new Set<GPUTextureFormat>([
  "rgba8unorm", "rgba8snorm", "rgba8uint", "rgba8sint",
  "rgba16float", "rgba16uint", "rgba16sint",
  "rgba32float", "rgba32uint", "rgba32sint",
  "r32float", "r32uint", "r32sint",
  "rg32float", "rg32uint", "rg32sint",
]);

export function createTexture(device: Device, opts: TextureOptions): Texture {
  validateTextureOptions(opts, device);
  const usage = opts.usage ?? DEFAULT_USAGE;
  const depth = opts.size[2];
  return device.createTexture({
    size: depth === undefined ? [opts.size[0], opts.size[1]] : [opts.size[0], opts.size[1], depth],
    format: opts.format,
    usage,
    dimension: opts.dimension,
    mipLevelCount: opts.mipLevelCount,
    label: opts.label,
  });
}

function validateTextureOptions(opts: Partial<TextureOptions> | undefined, device: Device): void {
  const size = opts?.size;
  if (!size || !isPositiveInteger(size[0]) || !isPositiveInteger(size[1]) || (size[2] !== undefined && !isPositiveInteger(size[2]))) throw textureSizeRequiredError();
  const usage = opts.usage ?? DEFAULT_USAGE;
  if (!usage.includes("storage_binding") || !opts.format) return;
  if (STORAGE_CAPABLE_FORMATS.has(opts.format)) return;
  if (opts.format === "bgra8unorm" && device.features.has("bgra8unorm-storage")) return;
  throw textureStorageFormatError(opts.format);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}
