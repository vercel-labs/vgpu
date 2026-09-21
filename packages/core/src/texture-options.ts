import { ValidationError } from "./errors.ts";
import type { TextureOptions } from "./types.ts";

const USAGES = new Set(["copy_src", "copy_dst", "texture_binding", "storage_binding", "render_attachment"]);
const STORAGE_FORMATS = new Set([
  "rgba8unorm", "rgba8snorm", "rgba8uint", "rgba8sint", "rgba16float", "rgba16uint", "rgba16sint",
  "rgba32float", "rgba32uint", "rgba32sint", "r32float", "r32uint", "r32sint", "rg32float", "rg32uint", "rg32sint",
]);
const TIER1_STORAGE_FORMATS = new Set([
  "r8unorm", "r8snorm", "r8uint", "r8sint", "rg8unorm", "rg8snorm", "rg8uint", "rg8sint",
  "r16uint", "r16sint", "r16float", "rg16uint", "rg16sint", "rg16float", "rgb10a2uint", "rgb10a2unorm", "rg11b10ufloat",
  "r16unorm", "r16snorm", "rg16unorm", "rg16snorm", "rgba16unorm", "rgba16snorm",
]);

/** Copy nested fields: caller mutations must never change metadata for an allocated GPU resource. */
export function snapshotTextureOptions(opts: TextureOptions): TextureOptions {
  return Object.freeze({
    ...opts,
    size: Object.freeze([...opts.size]),
    usage: Object.freeze([...opts.usage]),
    ...(opts.viewFormats === undefined ? {} : { viewFormats: Object.freeze([...opts.viewFormats]) }),
  }) as TextureOptions;
}

/** Native extent, never exposed as the semantic size of an array texture. */
export function textureExtent(opts: TextureOptions): readonly [number, number, number] {
  return [opts.size[0], opts.kind === "1d" ? 1 : opts.size[1], opts.kind === "2d-array" ? opts.layers : opts.kind === "3d" ? opts.size[2] : 1];
}

/** Synchronous API preflight. Native WebGPU remains responsible for full per-format/backend validation. */
export function validateTextureOptions(opts: TextureOptions, device: GPUDevice): void {
  const fail = (code: string, message: string, fix: string): never => {
    throw new ValidationError({ code, message, fix, where: "Device.createTexture" });
  };
  if (!opts || !["1d", "2d", "3d", "2d-array"].includes(opts.kind)) {
    fail("VGPU-TEXTURE-KIND-REQUIRED", "Texture kind must be explicit.", 'Pass kind: "1d", "2d", "3d", or "2d-array".');
  }
  if ("dimension" in opts) fail("VGPU-TEXTURE-KIND-REQUIRED", "Texture dimension has been replaced by kind.", 'Use kind and, for "2d-array", a separate layers count.');
  const axes = opts.kind === "1d" ? 1 : opts.kind === "3d" ? 3 : 2;
  if (!Array.isArray(opts.size) || opts.size.length !== axes || !Array.from(opts.size).every(positiveInteger)) {
    fail("VGPU-TEXTURE-SIZE-REQUIRED", `Texture ${opts.kind} needs ${axes} positive integer spatial dimensions.`, "Pass size with exactly the spatial dimensions of kind; put array layers in layers.");
  }
  if (opts.kind === "2d-array" ? !positiveInteger(opts.layers) : opts.layers !== undefined) {
    fail("VGPU-TEXTURE-LAYERS-INVALID", "Only 2d-array textures take a positive integer layers count.", 'Use kind: "2d-array", size: [width, height], layers: count.');
  }
  if (!Array.isArray(opts.usage) || opts.usage.length === 0 || !Array.from(opts.usage).every((usage) => USAGES.has(usage))) {
    fail("VGPU-TEXTURE-USAGE-REQUIRED", "Texture usage must be a nonempty list of known capabilities.", 'Pass explicit usage, such as ["texture_binding", "copy_dst"]. No capabilities are added automatically.');
  }
  if (typeof opts.format !== "string" || !opts.format) fail("VGPU-TEXTURE-FORMAT-REQUIRED", "Texture format is required.", 'Pass an explicit GPUTextureFormat, such as "rgba16float".');
  const levels = opts.mipLevelCount ?? 1;
  const maxLevels = opts.kind === "1d" ? 1 : Math.floor(Math.log2(Math.max(...opts.size))) + 1;
  if (!positiveInteger(levels) || levels > maxLevels) {
    fail("VGPU-TEXTURE-MIPS-INVALID", `mipLevelCount must be between 1 and ${maxLevels}.`, "Omit mipLevelCount for the base level, or request a valid allocation count. Contents are not generated automatically.");
  }
  const samples = opts.sampleCount ?? 1;
  if (samples !== 1 && samples !== 4) fail("VGPU-TEXTURE-SAMPLES-INVALID", "sampleCount must be 1 or 4.", "Omit sampleCount for single-sample storage.");
  if (samples === 4 && (opts.kind !== "2d" || levels !== 1 || !opts.usage.includes("render_attachment") || opts.usage.includes("storage_binding"))) {
    fail("VGPU-TEXTURE-SAMPLES-INVALID", "MSAA requires a 2d render attachment with one mip and no storage_binding.", "Use a single-sample texture for storage, arrays or volumes; resolve MSAA into a separate texture.");
  }
  if (opts.kind === "1d" && (opts.usage.includes("render_attachment") || /^(depth|stencil|bc|etc2|eac|astc)/.test(opts.format))) {
    fail("VGPU-TEXTURE-KIND-INVALID", "1d textures cannot be render attachments or use depth/stencil/compressed formats.", "Use a 2d texture or a plain color format with non-attachment usage.");
  }
  const extent = textureExtent(opts);
  const limitName = opts.kind === "1d" ? "maxTextureDimension1D" : opts.kind === "3d" ? "maxTextureDimension3D" : "maxTextureDimension2D";
  const limit = device.limits?.[limitName];
  if ((limit !== undefined && opts.size.some((size) => size > limit)) || (opts.kind === "2d-array" && device.limits?.maxTextureArrayLayers !== undefined && extent[2] > device.limits.maxTextureArrayLayers)) {
    fail("VGPU-TEXTURE-LIMIT", "Texture dimensions or layers exceed enabled device limits.", "Reduce the allocation or request sufficient limits when initializing the device.");
  }
  const hasFeature = (name: string) => device.features?.has(name as GPUFeatureName) ?? false;
  if (opts.usage.includes("storage_binding") && !STORAGE_FORMATS.has(opts.format)
    && !(opts.format === "bgra8unorm" && hasFeature("bgra8unorm-storage"))
    && !(TIER1_STORAGE_FORMATS.has(opts.format) && hasFeature("texture-formats-tier1"))) {
    fail("VGPU-TEXTURE-STORAGE-FORMAT", `Format ${opts.format} does not support storage_binding with the enabled features.`, "Choose a supported storage format, enable the required format feature, or explicitly omit storage_binding from usage.");
  }
  if (opts.viewFormats !== undefined && (!Array.isArray(opts.viewFormats) || !Array.from(opts.viewFormats).every((format) => typeof format === "string" && format.replace(/-srgb$/, "") === opts.format.replace(/-srgb$/, "")))) {
    fail("VGPU-TEXTURE-VIEW-FORMAT", "viewFormats must list formats compatible with the texture format.", "Only the same format or its compatible linear/sRGB counterpart is allowed; native device restrictions also apply.");
  }
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
