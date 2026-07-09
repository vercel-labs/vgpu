import { ValidationError, type Texture } from "@vgpu/core";
import type { ColorAttachmentSpec, RenderTargetGpu, RenderTargetMultiSpec, RenderTargetN } from "./types.ts";
import { markTextureCapturedByRenderTarget } from "./texture-resize-lock.ts";

const DEFAULT_CLEAR_COLOR = Object.freeze({ r: 0, g: 0, b: 0, a: 1 });
const COLOR_RENDERABLE_FORMATS = new Set<GPUTextureFormat>([
  "r8unorm", "r8snorm", "r8uint", "r8sint", "rg8unorm", "rg8snorm", "rg8uint", "rg8sint",
  "rgba8unorm", "rgba8unorm-srgb", "rgba8snorm", "rgba8uint", "rgba8sint", "bgra8unorm", "bgra8unorm-srgb",
  "rgb10a2uint", "rgb10a2unorm", "rg11b10ufloat", "rg32uint", "rg32sint", "rg32float",
  "rgba16uint", "rgba16sint", "rgba16float", "rgba32uint", "rgba32sint", "rgba32float",
]);

/** Creates an offscreen render target with N color textures and optional shared depth. */
export async function renderTargetMulti<const Specs extends readonly ColorAttachmentSpec[]>(
  spec: RenderTargetMultiSpec<Specs>,
): Promise<RenderTargetN<Specs>> {
  validateSpec(spec);
  const size = [spec.size[0], spec.size[1]] as const;
  const depthFormat = spec.depth === true ? "depth24plus" : spec.depth || undefined;
  const colors = spec.colors.map((color, index) => spec.device.createTexture({
    size,
    format: color.format,
    usage: ["render_attachment", "texture_binding"],
    sampleCount: 1,
    label: color.label ?? childLabel(spec.label, `color${index}`),
  }));
  const depth = depthFormat ? spec.device.createTexture({
    size,
    format: depthFormat,
    usage: ["render_attachment"],
    sampleCount: 1,
    label: childLabel(spec.label, "depth"),
  }) : undefined;
  for (const color of colors) markTextureCapturedByRenderTarget(color);
  markTextureCapturedByRenderTarget(depth);

  const colorAttachments = Object.freeze(colors.map((color, index) => ({
    view: color.createView(),
    loadOp: "clear" as const,
    storeOp: "store" as const,
    clearValue: colorDict(spec.colors[index]?.clearColor),
  })));
  const depthStencilAttachment = depth ? {
    view: depth.createView(),
    depthLoadOp: "clear" as const,
    depthStoreOp: "store" as const,
    depthClearValue: 1,
  } : undefined;
  const colorTextures = Object.freeze(colors.map((color) => color.gpu));
  const gpu: RenderTargetGpu = Object.freeze({
    colorAttachments,
    colorAttachment: colorAttachments[0] as GPURenderPassColorAttachment,
    depthStencilAttachment,
    colorTexture: colorTextures[0] as GPUTexture,
    colorTextures,
    depthTexture: depth?.gpu,
  });
  const frozenColors = Object.freeze(colors) as { readonly [K in keyof Specs]: Texture };
  return Object.freeze({
    color: colors[0] as Texture,
    colors: frozenColors,
    depth,
    size,
    format: spec.colors[0]?.format,
    sampleCount: 1,
    label: spec.label,
    gpu,
  }) as RenderTargetN<Specs>;
}

function validateSpec(spec: RenderTargetMultiSpec): void {
  if ("msaa" in spec) throw invalidUsage("RenderTargetMultiSpec.msaa is not supported for MRT v2.");
  if ("format" in spec) throw invalidUsage("RenderTargetMultiSpec uses per-attachment colors[].format instead of top-level format.");
  if ("clearColor" in spec) throw invalidUsage("RenderTargetMultiSpec uses per-attachment colors[].clearColor instead of top-level clearColor.");
  const size = spec.size as readonly number[];
  if (size.length !== 2 || !size.every((value) => Number.isInteger(value) && value > 0)) {
    throw invalidUsage("RenderTargetMultiSpec.size must be [width, height] with positive integer values.");
  }
  if (spec.colors.length < 1) throw invalidUsage("RenderTargetMultiSpec.colors must contain at least one color attachment.");
  const maxColorAttachments = spec.device.gpu.limits?.maxColorAttachments;
  if (maxColorAttachments !== undefined && spec.colors.length > maxColorAttachments) {
    throw invalidUsage(`RenderTargetMultiSpec.colors length ${spec.colors.length} exceeds device limit ${maxColorAttachments}.`);
  }
  for (const [index, color] of spec.colors.entries()) {
    if (!COLOR_RENDERABLE_FORMATS.has(color.format)) {
      throw invalidUsage(`RenderTargetMultiSpec.colors[${index}].format must be color-renderable; received ${color.format}.`);
    }
  }
}

function colorDict(color: ColorAttachmentSpec["clearColor"]): GPUColorDict {
  if (!color) return DEFAULT_CLEAR_COLOR;
  if (Array.isArray(color)) return { r: color[0], g: color[1], b: color[2], a: color[3] };
  return color as GPUColorDict;
}

function childLabel(label: string | undefined, suffix: string): string | undefined {
  return label ? `${label}.${suffix}` : undefined;
}

function invalidUsage(message: string): ValidationError {
  return new ValidationError({ code: "VGPU-CORE-INVALID-USAGE", message, where: "renderTargetMulti" });
}
