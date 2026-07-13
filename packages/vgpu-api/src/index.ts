import { notImplementedInit, type InitOptions } from "./init.ts";

export type { Gpu, InitOptions } from "./init.ts";
export type { AppCreateOptions, AppInstance, Buffer, Device, ResourceIdentity, Texture, VGPUAdapter } from "@vgpu/core";
export type { RenderTarget, RenderTargetSpec } from "@vgpu/render/passes";
export type { ResolvedShader, SourceMap, WGSLAst, WGSLSource } from "@vgpu/wgsl";

/** Browser entrypoint. Phase 2 wires this to navigator.gpu; Phase 0 keeps a throwing stub. */
export function init(options?: InitOptions): never {
  return notImplementedInit(options);
}
