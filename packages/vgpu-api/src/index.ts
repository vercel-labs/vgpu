import { createGpu, type InitOptions } from "./init.ts";

export type { Bundle, BundleOptions, BundleRecorder, Compute, ComputeOptions, Gpu, InitOptions, PingPongStorage, PingPongTargets, SharedUniforms, StorageAccess, StorageBuffer } from "./init.ts";
export type { Draw, DrawOptions, DrawCallOptions, DrawLayoutOptions, MeshLike } from "./draw.ts";
export type { Frame, FramePass, FramePassOptions, FrameLoopHandle, FrameLoopOptions, FrameRunner } from "./frame.ts";
export type { Pass, PassOptions } from "./pass.ts";
export type { Target, TargetOptions } from "./target.ts";
export { VGPUError } from "./errors.ts";
export type { Buffer, Device, ResourceIdentity, Texture, VGPUAdapter } from "@vgpu/core";
export { Uniform } from "./core/uniform.ts";
export type { UniformOptions } from "./core/uniform.ts";
export type { ResolvedShader, ShaderSource, SourceMap, WGSLAst, WGSLSource } from "@vgpu/wgsl";

/** Browser entrypoint. */
export function init(canvas: HTMLCanvasElement | OffscreenCanvas, options?: InitOptions): ReturnType<typeof createGpu>;
export function init(options?: InitOptions): ReturnType<typeof createGpu>;
export function init(canvasOrOptions?: HTMLCanvasElement | OffscreenCanvas | InitOptions, options?: InitOptions): ReturnType<typeof createGpu> {
  return createGpu("browser", canvasOrOptions, options);
}
