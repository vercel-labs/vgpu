import { createMockAdapter } from "@vgpu/adapter-mock";
import { createGpu, type InitOptions } from "./init.ts";

export { createMockAdapter } from "@vgpu/adapter-mock";
export { getMockGPUDeviceInstrumentation } from "@vgpu/core";
export type { Bundle, BundleOptions, BundleRecorder, Compute, ComputeOptions, Gpu, InitOptions, PingPongStorage, PingPongTargets, SharedUniforms, StorageAccess, StorageBuffer } from "./init.ts";
export type { Draw, DrawOptions, DrawCallOptions, DrawLayoutOptions, MeshLike, BundleBackReference, BundleBackReferenceRegistry, BundleStaleEvent } from "./draw.ts";
export type { Frame, FramePass, FramePassOptions, FrameLoopHandle } from "./frame.ts";
export type { Pass, PassOptions } from "./pass.ts";
export type { Target, TargetOptions } from "./target.ts";
export { VGPUError } from "./errors.ts";
export type { AppCreateOptions, AppInstance, Buffer, Device, ResourceIdentity, Texture, VGPUAdapter } from "@vgpu/core";
export { Uniform } from "./core/uniform.ts";
export type { UniformOptions } from "./core/uniform.ts";
export type { ResolvedShader, ShaderSource, SourceMap, WGSLAst, WGSLSource } from "@vgpu/wgsl";

/** Mock entrypoint. */
export function init(options?: InitOptions): ReturnType<typeof createGpu> {
  return createGpu("mock", options, {}, createMockAdapter);
}
