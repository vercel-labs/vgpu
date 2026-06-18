import { VGPUError, type Device } from "@vgpu/core";
import { toRenderPipelineDescriptor } from "./pipeline-descriptor.ts";
import type { RenderPipelineAsyncFallback, RenderPipelineOptions } from "./pipeline-descriptor.ts";

export type {
  RenderPipelineAsyncFallback,
  RenderPipelineFragmentOptions,
  RenderPipelineOptions,
  RenderPipelineShaderInput,
  RenderPipelineStageOptions,
  RenderPipelineVertexOptions,
} from "./pipeline-descriptor.ts";

// Warn once per JS process. This keeps compatibility fallback visible without spamming
// apps that intentionally warm up multiple pipelines on implementations without
// GPUDevice.createRenderPipelineAsync().
let didWarnAboutAsyncFallback = false;

type AsyncPipelineWhere = "createRenderPipelineAsync" | "createRenderPipelineFromDescriptorAsync";

export function createRenderPipeline(device: Device, opts: RenderPipelineOptions): GPURenderPipeline {
  return device.gpu.createRenderPipeline(toRenderPipelineDescriptor(opts));
}

export async function createRenderPipelineAsync(
  device: Device,
  opts: RenderPipelineOptions,
): Promise<GPURenderPipeline> {
  return createPipelineAsync(
    device,
    toRenderPipelineDescriptor(opts),
    opts.fallback,
    "createRenderPipelineAsync",
  );
}

/**
 * Create a render pipeline from a raw, hand-built `GPURenderPipelineDescriptor`.
 *
 * @remarks
 * Use this when you already own a native descriptor and only want VGPU's
 * `Device` wrapper to forward it — no `RenderPipelineOptions` reshape. The
 * descriptor is passed through unchanged.
 */
export function createRenderPipelineFromDescriptor(
  device: Device,
  descriptor: GPURenderPipelineDescriptor,
): GPURenderPipeline {
  return device.gpu.createRenderPipeline(descriptor);
}

/**
 * Async variant of {@link createRenderPipelineFromDescriptor} with the same
 * async→sync compatibility fallback as {@link createRenderPipelineAsync}.
 *
 * @remarks
 * The descriptor is forwarded unchanged. When `GPUDevice.createRenderPipelineAsync`
 * is unavailable, the default `fallback: "sync"` emits a once-only diagnostic and
 * calls the synchronous path; pass `fallback: "throw"` for a structured `VGPUError`.
 */
export async function createRenderPipelineFromDescriptorAsync(
  device: Device,
  descriptor: GPURenderPipelineDescriptor,
  fallback?: RenderPipelineAsyncFallback,
): Promise<GPURenderPipeline> {
  return createPipelineAsync(device, descriptor, fallback, "createRenderPipelineFromDescriptorAsync");
}

async function createPipelineAsync(
  device: Device,
  descriptor: GPURenderPipelineDescriptor,
  fallback: RenderPipelineAsyncFallback | undefined,
  where: AsyncPipelineWhere,
): Promise<GPURenderPipeline> {
  const createAsync = device.gpu.createRenderPipelineAsync;
  if (typeof createAsync === "function") {
    return createAsync.call(device.gpu, descriptor);
  }

  if ((fallback ?? "sync") === "throw") {
    throw new VGPUError({
      code: "VGPU-RENDER-PIPELINE-ASYNC-UNAVAILABLE",
      message: "GPUDevice.createRenderPipelineAsync is unavailable on this WebGPU implementation.",
      fix: "Use fallback: 'sync' for compatibility or call createRenderPipeline() explicitly during setup/warmup.",
      where,
    });
  }

  warnAsyncFallbackOnce();
  return device.gpu.createRenderPipeline(descriptor);
}

export function __resetCreateRenderPipelineAsyncFallbackWarningForTests(): void {
  didWarnAboutAsyncFallback = false;
}

function warnAsyncFallbackOnce(): void {
  if (didWarnAboutAsyncFallback) return;
  didWarnAboutAsyncFallback = true;
  globalThis.console?.warn?.(
    "[vgpu/render] createRenderPipelineAsync is unavailable; falling back to synchronous createRenderPipeline(). Pass fallback: 'throw' to make this a structured VGPUError.",
  );
}
