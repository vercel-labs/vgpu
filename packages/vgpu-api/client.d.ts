/// <reference types="@webgpu/types" />

declare module "vgpu/client" {
  export interface VGPUClientEnvironment {
    readonly gpu?: GPU;
  }

  export { wgslVitePlugin } from "@vgpu/wgsl/loader-vite";
  export type { ViteLoadResult, WgslVitePluginOptions } from "@vgpu/wgsl/loader-vite";
}

declare module "*.wgsl" {
  const source: string;
  export default source;
}
