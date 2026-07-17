import { createNodeAdapter } from "@vgpu/adapter-node";
import { createGpu, type InitOptions } from "./init.ts";

export { createNodeAdapter } from "@vgpu/adapter-node";
export type { Bundle, BundleOptions, BundleRecorder, Compute, ComputeOptions, Gpu, GpuErrorListener, InitOptions, PingPongStorage, PingPongTargets, SharedUniforms, StorageAccess, StorageBuffer, Surface, SurfaceOptions, SurfaceResizeEvent } from "./init.ts";
export type { Draw, DrawOptions, DrawCallOptions, DrawLayoutOptions, MeshLike } from "./draw.ts";
export type { Frame, FramePass, FramePassOptions, FrameLoopHandle, FrameLoopOptions, FrameRunner } from "./frame.ts";
export type { Effect, EffectOptions } from "./effect.ts";
export type { CompileTarget, Target, TargetOptions, TargetSignature, TargetTextureOptions } from "./target.ts";
export { VGPUError } from "./errors.ts";
export type { Buffer, Device, ResourceIdentity, Texture, VGPUAdapter } from "@vgpu/core";
export { Uniform } from "./core/uniform.ts";
export type { UniformOptions } from "./core/uniform.ts";
export type { ResolvedShader, ShaderSource, SourceMap, WGSLAst, WGSLSource } from "@vgpu/wgsl";

/** Node headless entrypoint (Dawn via @vgpu/adapter-node). */
export function init(options?: InitOptions): ReturnType<typeof createGpu> {
  return createGpu("node", options, {}, createNodeAdapter);
}
