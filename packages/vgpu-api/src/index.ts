import { createGpu, type InitOptions } from "./init.ts";

export type { Bundle, BundleOptions, BundleRecorder, Compute, ComputeOptions, DispatchOptions, Gpu, ClearColor, GpuErrorListener, InitOptions, PingPongStorage, PingPongTargets, SharedUniforms, StorageAccess, StorageBuffer, StorageOptions, Surface, SurfaceOptions, SurfaceResizeEvent, Timer, TimerSpan, Visibility, VisibilityOptions, VisibilityQuery } from "./init.ts";
export type { BlendComponentOptions, BlendOptions, BlendPreset, DepthOptions, Draw, DrawOptions, DrawCallOptions, DrawLayoutOptions, GeometryLike, StencilFaceOptions, StencilOptions } from "./draw.ts";
export { Geometry } from "./scene/geometry-descriptor.ts";
export type { GeometryAttributeOverride, GeometryAttributes, GeometryBuffer, GeometryBufferOptions, GeometryData, GeometryOptions, GeometrySlice, GeometrySliceOptions } from "./scene/geometry-descriptor.ts";
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
