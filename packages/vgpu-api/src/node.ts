import { createNodeAdapter, describeNodeAdapter, nodeAdapterEnvironmentOverride, type NodeAdapterInfo, type NodeAdapterMode } from "@vgpu/adapter-node";
import type { VGPUAdapter } from "@vgpu/core";
import { createGpu, type Gpu, type InitOptions } from "./init.ts";

export { createNodeAdapter } from "@vgpu/adapter-node";
export type { Bundle, BundleOptions, BundleRecorder, Compute, ComputeOptions, Gpu, ClearColor, GpuErrorListener, PingPongStorage, PingPongTargets, SharedUniforms, StorageAccess, StorageBuffer, Surface, SurfaceOptions, SurfaceResizeEvent } from "./init.ts";
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

export interface NodeInitOptions extends Omit<InitOptions, "adapter"> { readonly adapter?: NodeAdapterMode | VGPUAdapter }
export interface NodeGpu extends Gpu { readonly adapter: NodeAdapterInfo }

/** Node headless entrypoint (Dawn via @vgpu/adapter-node). */
export async function init(options: NodeInitOptions = {}): Promise<NodeGpu> {
  const override = nodeAdapterEnvironmentOverride();
  const requested = override ?? options.adapter ?? "auto";
  const custom = typeof requested === "object" ? requested : undefined;
  const { adapter: _, ...deviceOptions } = options;
  const gpu = await createGpu("node", custom ? { ...deviceOptions, adapter: custom } : deviceOptions, {}, () => createNodeAdapter({ adapter: typeof requested === "string" ? requested : "auto" }));
  return Object.assign(gpu, { adapter: Object.freeze(describeNodeAdapter(gpu.device.adapterInfo)) });
}
