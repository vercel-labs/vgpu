import { createGpu, type InitOptions } from "./init.ts";

export type { Bundle, BundleOptions, BundleRecorder, Compute, ComputeOptions, Gpu, ClearColor, GpuErrorListener, InitOptions, PingPongStorage, PingPongTargets, SharedUniforms, StorageAccess, StorageBuffer, Surface, SurfaceOptions, SurfaceResizeEvent } from "./init.ts";
export type { BlendComponentOptions, BlendOptions, BlendPreset, Draw, DrawOptions, DrawCallOptions, DrawLayoutOptions, MeshLike } from "./draw.ts";
export { Mesh } from "./scene/mesh-descriptor.ts";
export type { MeshAttributeOverride, MeshAttributes, MeshBuffer, MeshBufferOptions, MeshData, MeshOptions, MeshSlice, MeshSliceOptions } from "./scene/mesh-descriptor.ts";
export type { Frame, FramePass, FramePassOptions, FrameLoopHandle, FrameLoopOptions, FrameRunner } from "./frame.ts";
export type { Effect, EffectOptions } from "./effect.ts";
export type { CompileTarget, Target, TargetOptions, TargetSignature, TargetTextureOptions } from "./target.ts";
export { VGPUError } from "./errors.ts";
export type { Buffer, Device, ResourceIdentity, Texture, VGPUAdapter } from "@vgpu/core";
export { Uniform } from "./core/uniform.ts";
export type { UniformOptions } from "./core/uniform.ts";
export type { ResolvedShader, ShaderSource, SourceMap, WGSLAst, WGSLSource } from "@vgpu/wgsl";

/** Browser entrypoint. */
export function init(options?: InitOptions): ReturnType<typeof createGpu> {
  return createGpu("browser", options);
}
