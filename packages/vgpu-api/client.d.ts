/// <reference types="@webgpu/types" />

declare module "vgpu/client" {
  export interface VGPUClientEnvironment {
    readonly gpu?: GPU;
  }

  export interface ShaderFunctionExport {
    readonly name: string;
    readonly resolvedName: string;
    readonly parameterNames: readonly string[];
  }

  export interface ShaderSource {
    readonly version: 1;
    readonly wgsl: string;
    readonly functionExports?: readonly ShaderFunctionExport[];
  }

  export { wgslVitePlugin } from "@vgpu/wgsl/loader-vite";
  export type { ViteLoadResult, WgslVitePluginOptions } from "@vgpu/wgsl/loader-vite";
}

declare module "*.wgsl" {
  const source: import("vgpu/client").ShaderSource;
  export default source;
}
