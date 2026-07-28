import { targetSizeRequiredError, targetStencilOnlyDepthError, unsupportedError } from "./errors.ts";
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
  const depthFormat = depthFormatFor(options);
  // Stencil-only formats have no depth aspect, so the default depth state (depthWriteEnabled: true) cannot compile against them.
  if (depthFormat === "stencil8") throw targetStencilOnlyDepthError(depthFormat);
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

export function depthAttachment(depth: { createView(): GPUTextureView; readonly sampleCount?: number; readonly format?: GPUTextureFormat }, preserve?: boolean, clearDepth?: number, clearStencil?: number, readOnly?: boolean): GPURenderPassDepthStencilAttachment {
  if (readOnly) {
    // WebGPU requires the ops to be OMITTED for read-only aspects: "If format has a depth aspect and
    // this.depthReadOnly is false: this.depthLoadOp must be provided. this.depthStoreOp must be provided.
    // Otherwise: this.depthLoadOp must not be provided. this.depthStoreOp must not be provided." — and the
    // same for stencilLoadOp/stencilStoreOp with stencilReadOnly, so combined formats mark both aspects.
    const attachment: GPURenderPassDepthStencilAttachment = { view: depth.createView(), depthReadOnly: true };
    if (hasStencilAspect(depth.format)) attachment.stencilReadOnly = true;
    return attachment;
  }
  const attachment: GPURenderPassDepthStencilAttachment = { view: depth.createView(), depthLoadOp: preserve ? "load" : "clear", depthStoreOp: depth.sampleCount! > 1 ? "discard" : "store" };
  if (!preserve) attachment.depthClearValue = clearDepth ?? 1;
  // WebGPU requires stencilLoadOp/stencilStoreOp whenever the format has a stencil aspect and stencilReadOnly is not set.
  if (depth.format && hasStencilAspect(depth.format)) {
    attachment.stencilLoadOp = preserve ? "load" : "clear";
    attachment.stencilStoreOp = depth.sampleCount! > 1 ? "discard" : "store";
    if (!preserve) attachment.stencilClearValue = clearStencil ?? 0;
  }
  return attachment;
}

export function hasStencilAspect(format: GPUTextureFormat | undefined): boolean {
  return !!format && format.includes("stencil");
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
