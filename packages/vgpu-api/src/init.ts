export { createGpu, type AdapterFactory, type Compute, type ComputeOptions, type Gpu, type InitOptions, type PingPongStorage, type PingPongTargets, type SharedUniforms, type StorageAccess, type StorageBuffer } from "./gpu.ts";
export type { Bundle, BundleOptions, BundleRecorder } from "./bundle.ts";

import { createGpu, type AdapterFactory, type InitOptions } from "./gpu.ts";

export function initWithAdapter(entry: "browser" | "node" | "mock", adapterFactory?: AdapterFactory, options?: InitOptions) {
  return createGpu(entry, options, {}, adapterFactory);
}
