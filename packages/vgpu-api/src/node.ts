import { createNodeAdapter } from "@vgpu/adapter-node";
import { initWithAdapter, type InitOptions } from "./init.ts";

export { createNodeAdapter } from "@vgpu/adapter-node";
export type { Gpu, InitOptions } from "./init.ts";
export type { AppCreateOptions, AppInstance, Buffer, Device, ResourceIdentity, Texture, VGPUAdapter } from "@vgpu/core";
export type { RenderTarget, RenderTargetSpec } from "@vgpu/render/passes";
export type { ResolvedShader, SourceMap, WGSLAst, WGSLSource } from "@vgpu/wgsl";

/** Node entrypoint. Phase 2 wires this to Dawn; Phase 0 keeps a throwing stub. */
export function init(_options?: InitOptions): never {
  return initWithAdapter("node", createNodeAdapter);
}
