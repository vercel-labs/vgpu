/// <reference types="@vgpu/wgsl/wgsl-types" />

/**
 * Shared client-environment typing surface. Attach it to `vgpu-env.d.ts`
 * via `/// <reference types="vgpu/client" />` to make `.wgsl` imports legal
 * for `tsc` while prepared artifact metadata remains the runtime input.
 */
export type VGPUClientEnvironment = {
  readonly gpu?: GPU;
};

export { wgslVitePlugin } from "@vgpu/wgsl/loader-vite";
export type { ShaderFunctionExport, ShaderReflection, ShaderSource } from "@vgpu/wgsl";
export type { ViteLoadResult, WgslVitePluginOptions } from "@vgpu/wgsl/loader-vite";
