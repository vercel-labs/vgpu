import { createNodeAdapter, describeNodeAdapter, nodeAdapterEnvironmentOverride, type NodeAdapterInfo, type NodeAdapterMode } from "@vgpu/adapter-node";
import type { VGPUAdapter } from "@vgpu/core";
import { createGpu, type ExternalDeviceInitOptions, type Gpu, type RequestedDeviceInitOptions } from "./init.ts";
import { normalizeInitOptions } from "./kernel.ts";

export { createNodeAdapter } from "@vgpu/adapter-node";
export type { Bundle, BundleOptions, BundleRecorder, Compute, ComputeOptions, DispatchOptions, ClearColor, GpuErrorListener, PingPongStorage, PingPongTargets, SharedUniforms, StorageAccess, StorageBuffer, StorageOptions, Surface, SurfaceOptions, SurfaceResizeEvent, Timer, TimerSpan, Visibility, VisibilityOptions, VisibilityQuery } from "./init.ts";
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

type NodeRequestedDeviceInitOptions = Omit<RequestedDeviceInitOptions, "adapter"> & { readonly adapter?: NodeAdapterMode | VGPUAdapter };
export type NodeInitOptions = NodeRequestedDeviceInitOptions | ExternalDeviceInitOptions;
// Nullable: an external device arrives without an adapter, so there is no Dawn adapter to describe.
export interface NodeGpu extends Gpu { readonly adapter: NodeAdapterInfo | null }

/** Node headless entrypoint (Dawn via @vgpu/adapter-node). */
export async function init(options: NodeInitOptions = {}): Promise<NodeGpu> {
  const normalized = normalizeInitOptions(options) as NodeInitOptions;
  if ("device" in normalized) {
    const gpu = await createGpu("node", normalized as ExternalDeviceInitOptions);
    return Object.assign(gpu, { adapter: null });
  }
  const override = nodeAdapterEnvironmentOverride();
  const requested = override ?? normalized.adapter ?? "auto";
  const custom = typeof requested === "object" ? requested : undefined;
  // `normalized`, not `options`: the raw value is still unvalidated here.
  const { adapter: _, ...deviceOptions } = normalized;
  const gpu = await createGpu("node", custom ? { ...deviceOptions, adapter: custom } : deviceOptions, () => createNodeAdapter({ adapter: typeof requested === "string" ? requested : "auto" }));
  return Object.assign(gpu, { adapter: Object.freeze(describeNodeAdapter(gpu.device.adapterInfo)) });
}
