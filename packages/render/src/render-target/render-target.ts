import { ValidationError } from "@vgpu/core";
import type { Texture } from "@vgpu/core";
import type { RenderTarget, RenderTargetGpu, RenderTargetSpec } from "./types.ts";

const DEFAULT_FORMAT: GPUTextureFormat = "rgba8unorm";
const DEFAULT_CLEAR_COLOR = Object.freeze({ r: 0, g: 0, b: 0, a: 1 });
const COLOR_RENDERABLE_FORMATS = new Set<GPUTextureFormat>([
  "r8unorm", "r8snorm", "r8uint", "r8sint", "rg8unorm", "rg8snorm", "rg8uint", "rg8sint",
  "rgba8unorm", "rgba8unorm-srgb", "rgba8snorm", "rgba8uint", "rgba8sint", "bgra8unorm", "bgra8unorm-srgb",
  "rgb10a2uint", "rgb10a2unorm", "rg11b10ufloat", "rg32uint", "rg32sint", "rg32float",
  "rgba16uint", "rgba16sint", "rgba16float", "rgba32uint", "rgba32sint", "rgba32float",
]);

/**
 * Creates an offscreen render target with one sampleable color texture, optional
 * depth, and optional MSAA resolve. Label propagation follows the locked v1
 * decision: non-MSAA uses `${label}.color`; MSAA uses `${label}.color` for the
 * multisample attachment and `${label}.color.resolve` for the exposed sampleable
 * `.color` texture. Depth uses `${label}.depth`.
 */
export async function renderTarget(spec: RenderTargetSpec): Promise<RenderTarget> {
  validateSpec(spec);
  const format = spec.format ?? DEFAULT_FORMAT;
  const depthFormat = spec.depth === true ? "depth24plus" : spec.depth || undefined;
  const sampleCount: 1 | 4 = spec.msaa === true || spec.msaa === 4 ? 4 : 1;
  const clearColor = colorDict(spec.clearColor);
  const size = [spec.size[0], spec.size[1]] as const;

  const color = spec.device.createTexture({
    size,
    format,
    usage: ["render_attachment", "texture_binding"],
    sampleCount,
    label: childLabel(spec.label, "color"),
  });
  const resolve = sampleCount === 4 ? spec.device.createTexture({
    size,
    format,
    usage: ["render_attachment", "texture_binding"],
    sampleCount: 1,
    label: childLabel(spec.label, "color.resolve"),
  }) : undefined;
  const depth = depthFormat ? spec.device.createTexture({
    size,
    format: depthFormat,
    usage: ["render_attachment"],
    sampleCount,
    label: childLabel(spec.label, "depth"),
  }) : undefined;
  const sampleableColor = resolve ?? color;
  const colorAttachment: GPURenderPassColorAttachment = {
    view: color.createView(),
    resolveTarget: resolve?.createView(),
    loadOp: "clear",
    storeOp: "store",
    clearValue: clearColor,
  };
  const depthStencilAttachment = depth ? {
    view: depth.createView(),
    depthLoadOp: "clear" as const,
    depthStoreOp: "store" as const,
    depthClearValue: 1,
  } : undefined;
  const colorAttachments = Object.freeze([colorAttachment]);
  const colorTextures = Object.freeze([color.gpu]);
  const gpu: RenderTargetGpu = Object.freeze({
    colorAttachments,
    colorAttachment,
    depthStencilAttachment,
    colorTexture: color.gpu,
    colorTextures,
    resolveTexture: resolve?.gpu,
    depthTexture: depth?.gpu,
  });
  const colors = Object.freeze([sampleableColor]) as readonly [Texture, ...Texture[]];
  return Object.freeze({ color: sampleableColor, colors, depth, size, format, sampleCount, label: spec.label, gpu });
}

function validateSpec(spec: RenderTargetSpec): void {
  const size = spec.size as readonly number[];
  if (size.length !== 2 || !size.every((value) => Number.isInteger(value) && value > 0)) {
    throw invalidUsage("RenderTargetSpec.size must be [width, height] with positive integer values.");
  }
  const format = spec.format ?? DEFAULT_FORMAT;
  if (!COLOR_RENDERABLE_FORMATS.has(format)) throw invalidUsage(`RenderTargetSpec.format must be color-renderable; received ${format}.`);
  if (spec.msaa !== undefined && spec.msaa !== false && spec.msaa !== true && spec.msaa !== 4) {
    throw invalidUsage("RenderTargetSpec.msaa must be true, false, or 4.");
  }
}

function colorDict(color: RenderTargetSpec["clearColor"]): GPUColorDict {
  if (!color) return DEFAULT_CLEAR_COLOR;
  if (Array.isArray(color)) return { r: color[0], g: color[1], b: color[2], a: color[3] };
  return color as GPUColorDict;
}

function childLabel(label: string | undefined, suffix: string): string | undefined {
  return label ? `${label}.${suffix}` : undefined;
}

function invalidUsage(message: string): ValidationError {
  return new ValidationError({ code: "VGPU-CORE-INVALID-USAGE", message, where: "renderTarget" });
}
