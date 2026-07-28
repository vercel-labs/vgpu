export { createGpu, type AdapterFactory, type Compute, type ComputeOptions, type DispatchOptions, type ExternalDeviceInitOptions, type Gpu, type GpuErrorListener, type InitOptions, type RequestedDeviceInitOptions, type PingPongStorage, type PingPongTargets, type SharedUniforms, type StorageAccess, type StorageBuffer, type StorageOptions } from "./gpu.ts";
export type { ClearColor } from "./target-utils.ts";
export type { Timer, TimerSpan } from "./timer.ts";
export type { Visibility, VisibilityOptions, VisibilityQuery } from "./visibility.ts";
export type { Bundle, BundleOptions, BundleRecorder } from "./bundle.ts";
export type { Surface, SurfaceOptions, SurfaceResizeEvent } from "./surface.ts";

import { createGpu, type AdapterFactory, type InitOptions } from "./gpu.ts";

export function initWithAdapter(entry: "browser" | "node" | "mock", adapterFactory?: AdapterFactory, options?: InitOptions) {
  return createGpu(entry, options, {}, adapterFactory);
}
