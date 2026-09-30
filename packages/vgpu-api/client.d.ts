/// <reference types="@webgpu/types" />
/// <reference types="@vgpu/wgsl/wgsl-types" />

declare module "vgpu/client" {
  export interface VGPUClientEnvironment {
    readonly gpu?: GPU;
  }

  export { wgslVitePlugin } from "@vgpu/wgsl/loader-vite";
  export type { ShaderFunctionExport, ShaderReflection, ShaderSource } from "@vgpu/wgsl";
  export type { ViteLoadResult, WgslVitePluginOptions } from "@vgpu/wgsl/loader-vite";
}
