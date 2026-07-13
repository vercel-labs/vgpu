import type { VGPUAdapter } from "@vgpu/core";

export interface InitOptions {
  readonly adapter?: VGPUAdapter;
}

export interface Gpu {
  readonly adapter?: VGPUAdapter;
}

export type AdapterFactory = () => VGPUAdapter;

export function notImplementedInit(_options: InitOptions = {}): never {
  throw new Error("not implemented");
}

export function initWithAdapter(_entry: "browser" | "node" | "mock", _adapterFactory?: AdapterFactory): never {
  throw new Error("not implemented");
}
