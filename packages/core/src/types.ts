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

export type RequiredDeviceLimits = Partial<{ readonly [K in keyof GPUSupportedLimits]: GPUSize64 }>;

export interface CreateDeviceOptions {
  readonly powerPreference?: GPUPowerPreference;
  readonly requiredFeatures?: readonly GPUFeatureName[];
  readonly requiredLimits?: RequiredDeviceLimits;
  readonly label?: string;
}

export interface VGPUAdapter {
  requestDevice(opts?: CreateDeviceOptions): Promise<Device>;
}

export type BufferWriteData = ArrayBuffer | ArrayBufferView<ArrayBuffer>;

export type TextureUsageName = "copy_src" | "copy_dst" | "texture_binding" | "storage_binding" | "render_attachment";

/** Read one mip, with texel coordinates relative to that mip. `all` includes every slice. */
export interface TextureReadOptions {
  readonly mipLevel: number;
  readonly region: "all" | {
    readonly origin: readonly [number, number, number];
    readonly size: readonly [number, number, number];
  };
}

export type TextureShape =
  | { readonly kind: "1d"; readonly size: readonly [width: number]; readonly layers?: never }
  | { readonly kind: "2d"; readonly size: readonly [width: number, height: number]; readonly layers?: never }
  | { readonly kind: "3d"; readonly size: readonly [width: number, height: number, depth: number]; readonly layers?: never }
  | { readonly kind: "2d-array"; readonly size: readonly [width: number, height: number]; readonly layers: number };

export type TextureOptions = TextureShape & {
  readonly format: GPUTextureFormat;
  readonly usage: readonly [TextureUsageName, ...TextureUsageName[]];
  /** Number of mip levels. Defaults to 1 when omitted, matching WebGPU. */
  readonly mipLevelCount?: number;
  /** Number of samples per pixel. Use 4 for MSAA; default 1. WebGPU spec restricts color render targets to sampleCount 1 or 4. */
  readonly sampleCount?: 1 | 4;
  /** Additional view formats allowed for texture view creation. Defaults to none when omitted, matching WebGPU. */
  readonly viewFormats?: readonly GPUTextureFormat[];
  readonly label?: string;
};
