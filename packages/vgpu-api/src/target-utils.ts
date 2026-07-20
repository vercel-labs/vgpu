import { targetSizeRequiredError, unsupportedError } from "./errors.ts";
import type { Target, TargetOptions, TargetTextureOptions } from "./target.ts";

export const DEFAULT_FORMAT: GPUTextureFormat = "rgba8unorm";
export type ClearColor = GPUColor | readonly [number, number, number, number];

export interface TargetDeviceCaps {
  readonly isCompatibilityMode?: boolean;
}

export function colorSpecsFor(options: TargetTextureOptions): readonly { readonly format: GPUTextureFormat }[] {
  return options.colors ?? [{ format: options.format ?? DEFAULT_FORMAT }];
}

export function depthFormatFor(options: TargetTextureOptions): GPUTextureFormat | undefined {
  return options.depth === true ? "depth24plus" : options.depth || undefined;
}

export function sampleCountFor(options: TargetTextureOptions): 1 | 4 {
  const msaa = options.msaa as unknown;
  if (msaa === true || msaa === 4) return 4;
  if (msaa === undefined || msaa === false) return 1;
  const e = targetSizeRequiredError();
  (e as { code: string }).code = "VGPU-TARGET-MSAA-INVALID";
  e.message = `msaa received ${msaa}; WebGPU 1|4; use true`;
  throw e;
}

export function validateTargetOptions(options: Partial<TargetOptions> | undefined, caps: TargetDeviceCaps): void {
  if (!options?.size) throw targetSizeRequiredError();
  if (sampleCountFor(options) !== 4) return;
  for (const spec of colorSpecsFor(options)) validateMsaaFormat(spec.format, caps);
}

function validateMsaaFormat(format: GPUTextureFormat, caps: TargetDeviceCaps): void {
  if (!(caps.isCompatibilityMode && format === "rgba16float")) return;
  throw unsupportedError(
    "gpu.target",
    "Dawn compatibility mode does not support rgba16float+msaa.",
    "Use rgba8unorm for MSAA here, or disable msaa.",
  );
}

export function colorAttachment(resolved: { createView(): GPUTextureView }, msaa: { createView(): GPUTextureView } | undefined, clear: ClearColor, preserve?: boolean): GPURenderPassColorAttachment {
  const attachment: GPURenderPassColorAttachment = {
    view: (msaa ?? resolved).createView(),
    resolveTarget: msaa ? resolved.createView() : undefined,
    loadOp: preserve ? "load" : "clear",
    storeOp: msaa ? "discard" : "store",
  };
  if (!preserve) attachment.clearValue = colorValue(clear);
  return attachment;
}

export function depthAttachment(depth: { createView(): GPUTextureView; readonly sampleCount?: number }, preserve?: boolean): GPURenderPassDepthStencilAttachment {
  const attachment: GPURenderPassDepthStencilAttachment = { view: depth.createView(), depthLoadOp: preserve ? "load" : "clear", depthStoreOp: depth.sampleCount! > 1 ? "discard" : "store" };
  if (!preserve) attachment.depthClearValue = 1;
  return attachment;
}

export function colorValue(clear: ClearColor): GPUColor {
  return Array.isArray(clear) ? { r: clear[0], g: clear[1], b: clear[2], a: clear[3] } : clear;
}

export function sameSize(a: readonly [number, number], b: readonly [number, number]): boolean {
  return a[0] === b[0] && a[1] === b[1];
}


/** @internal Internal normalization guard: `renderPassDescriptor` is required on Target and never on options bags. */
export function isTarget(value: unknown): value is Target {
  return typeof value === "object" && value !== null
    && typeof (value as Target).renderPassDescriptor === "function";
}
