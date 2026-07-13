import { createMockAdapter } from "@vgpu/adapter-mock";
import { initWithAdapter, type InitOptions } from "./init.ts";

export { createMockAdapter } from "@vgpu/adapter-mock";
export type { Gpu, InitOptions } from "./init.ts";
export type { AppCreateOptions, AppInstance, Buffer, Device, ResourceIdentity, Texture, VGPUAdapter } from "@vgpu/core";
export type { RenderTarget, RenderTargetSpec } from "@vgpu/render/passes";
export type { ResolvedShader, SourceMap, WGSLAst, WGSLSource } from "@vgpu/wgsl";

/** Mock entrypoint. Phase 2 wires this to @vgpu/adapter-mock; Phase 0 keeps a throwing stub. */
export function init(_options?: InitOptions): never {
  return initWithAdapter("mock", createMockAdapter);
}
