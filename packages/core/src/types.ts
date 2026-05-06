import type { Device } from "./device.ts";

export type BufferUsageName =
  | "map_read"
  | "map_write"
  | "copy_src"
  | "copy_dst"
  | "index"
  | "vertex"
  | "uniform"
  | "storage"
  | "indirect"
  | "query_resolve";

export interface BufferOptions {
  readonly size: number;
  readonly usage: readonly BufferUsageName[];
  readonly label?: string;
}

export interface CreateDeviceOptions {
  readonly powerPreference?: GPUPowerPreference;
  readonly requiredFeatures?: readonly GPUFeatureName[];
  readonly requiredLimits?: Record<string, number>;
  readonly label?: string;
}

export interface AppCreateOptions extends CreateDeviceOptions {
  readonly adapter: VGPUAdapter;
}

export interface AppInstance {
  readonly device: Device;
  readonly queue: Device["queue"];
}

export interface VGPUAdapter {
  requestDevice(opts?: CreateDeviceOptions): Promise<Device>;
}

export type BufferWriteData = ArrayBuffer | ArrayBufferView<ArrayBuffer>;

export type TextureUsageName = "copy_src" | "copy_dst" | "texture_binding" | "storage_binding" | "render_attachment";

export interface TextureOptions {
  readonly size: readonly [width: number, height: number, depthOrArrayLayers?: number];
  readonly format: GPUTextureFormat;
  readonly usage: readonly TextureUsageName[];
  readonly label?: string;
}

