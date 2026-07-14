/**
 * Shared client-environment typing surface. Attach it to `vgpu-env.d.ts`
 * via `/// <reference types="vgpu/client" />` to make `.wgsl` imports legal
 * for `tsc` while runtime reflection remains the authority for validation.
 */
export type VGPUClientEnvironment = {
  readonly gpu?: GPU;
};

export { wgslVitePlugin } from "@vgpu/wgsl/loader-vite";
export type { ShaderSource } from "@vgpu/wgsl";
export type { ViteLoadResult, WgslVitePluginOptions } from "@vgpu/wgsl/loader-vite";
