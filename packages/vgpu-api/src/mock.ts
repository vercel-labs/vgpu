import { createMockAdapter } from "@vgpu/adapter-mock";
import { createGpu, type InitOptions } from "./init.ts";
export { initFromDevice } from "./init-from-device.ts";

export { createMockAdapter } from "@vgpu/adapter-mock";
export type { CreateMockAdapterOptions } from "@vgpu/adapter-mock";
export { getMockGPUDeviceInstrumentation } from "@vgpu/core";
export type { Bundle, BundleOptions, BundleRecorder, Compute, ComputeOptions, DispatchOptions, ClearColor, GpuErrorListener, InitOptions, PingPongStorage, PingPongTargets, SharedUniforms, StorageAccess, StorageBuffer, StorageOptions, Surface, SurfaceOptions, SurfaceResizeEvent, Timer, TimerSpan, Visibility, VisibilityOptions, VisibilityQuery } from "./init.ts";
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
export type { ResolvedShader, ShaderFunctionExport, ShaderSource, SourceMap, WGSLAst, WGSLSource } from "@vgpu/wgsl";

// --- The public creation API: gpu-first free functions. There is no facade — the `Gpu` is a
// device handle plus a lifetime, and everything else takes it as its first argument.
export type { Gpu } from "./kernel.ts";
export { bundle } from "./bundle.ts";
export { clock } from "./clock.ts";
export type { Clock } from "./clock.ts";
export { compute } from "./compute.ts";
export { draw } from "./draw.ts";
export { effect } from "./effect.ts";
export { frame, frameLoop } from "./frame.ts";
export type { FrameLoopCallback } from "./frame.ts";
export { pingPong, pingPongStorage } from "./ping-pong.ts";
export { sampler } from "./sampler.ts";
export { storage } from "./storage.ts";
export { surface } from "./surface.ts";
export type { SurfaceCanvas } from "./surface.ts";
export { target } from "./target-offscreen.ts";
export { timer } from "./timer.ts";
export { uniforms } from "./uniforms.ts";
export { visibility } from "./visibility.ts";
export { geometry } from "./scene/geometry-descriptor.ts";
export type { GeometryRecipe, GeometryRecipeOf } from "./scene/geometry-recipe.ts";

/** Mock entrypoint. */
export function init(options?: InitOptions): ReturnType<typeof createGpu> {
  return createGpu("mock", options, createMockAdapter);
}
