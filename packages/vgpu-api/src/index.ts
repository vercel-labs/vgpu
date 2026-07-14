import { createGpu, type InitOptions } from "./init.ts";

export type { Bundle, BundleOptions, BundleRecorder, Compute, ComputeOptions, Gpu, InitOptions, PingPongStorage, PingPongTargets, SharedUniforms, StorageAccess, StorageBuffer } from "./init.ts";
export { Draw } from "./draw.ts";
export type { DrawOptions, DrawCallOptions, DrawLayoutOptions, MeshLike, BundleBackReference, BundleBackReferenceRegistry, BundleStaleEvent } from "./draw.ts";
export { Frame, FramePass, FrameRunner } from "./frame.ts";
export type { FramePassOptions, FrameLoopHandle } from "./frame.ts";
export { Pass } from "./pass.ts";
export type { PassOptions } from "./pass.ts";
export { OffscreenTarget, ScreenTarget } from "./target.ts";
export type { Target, TargetOptions } from "./target.ts";
export { VGPUError } from "./errors.ts";
export type { AppCreateOptions, AppInstance, Buffer, Device, ResourceIdentity, Texture, VGPUAdapter } from "@vgpu/core";
export { Uniform } from "@vgpu/render";
export type { UniformOptions } from "@vgpu/render";
export type { RenderTarget, RenderTargetSpec } from "@vgpu/render/passes";
export type { ResolvedShader, ShaderSource, SourceMap, WGSLAst, WGSLSource } from "@vgpu/wgsl";

/** Browser entrypoint. */
export function init(canvas: HTMLCanvasElement | OffscreenCanvas, options?: InitOptions): ReturnType<typeof createGpu>;
export function init(options?: InitOptions): ReturnType<typeof createGpu>;
export function init(canvasOrOptions?: HTMLCanvasElement | OffscreenCanvas | InitOptions, options?: InitOptions): ReturnType<typeof createGpu> {
  return createGpu("browser", canvasOrOptions, options);
}
