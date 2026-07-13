import { createNodeAdapter } from "@vgpu/adapter-node";
import { createGpu, type InitOptions } from "./init.ts";

export { createNodeAdapter } from "@vgpu/adapter-node";
export type { Gpu, InitOptions } from "./init.ts";
export type { Draw, DrawOptions, DrawCallOptions, MeshLike, BundleBackReference, BundleBackReferenceRegistry } from "./draw.ts";
export type { Frame, FramePass, FramePassOptions, FrameLoopHandle } from "./frame.ts";
export type { Pass, PassOptions } from "./pass.ts";
export type { Target, TargetOptions } from "./target.ts";
export { VGPUError } from "./errors.ts";
export type { AppCreateOptions, AppInstance, Buffer, Device, ResourceIdentity, Texture, VGPUAdapter } from "@vgpu/core";
export type { RenderTarget, RenderTargetSpec } from "@vgpu/render/passes";
export type { ResolvedShader, SourceMap, WGSLAst, WGSLSource } from "@vgpu/wgsl";

/** Node headless entrypoint (Dawn via @vgpu/adapter-node). */
export function init(options?: InitOptions): ReturnType<typeof createGpu> {
  return createGpu("node", options, {}, createNodeAdapter);
}
