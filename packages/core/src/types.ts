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

export type BufferWriteData = ArrayBuffer | ArrayBufferView<ArrayBuffer>;

export type TextureUsageName = "copy_src" | "copy_dst" | "texture_binding" | "storage_binding" | "render_attachment";

export interface TextureOptions {
  readonly size: readonly [width: number, height: number, depthOrArrayLayers?: number];
  readonly format: GPUTextureFormat;
  readonly usage: readonly TextureUsageName[];
  /** Number of mip levels. Defaults to 1 when omitted, matching WebGPU. */
  readonly mipLevelCount?: number;
  /** Number of samples per pixel. Use 4 for MSAA; default 1. WebGPU spec restricts color render targets to sampleCount 1 or 4. */
  readonly sampleCount?: 1 | 4;
  /** Texture dimensionality. Defaults to "2d" when omitted, matching WebGPU. */
  readonly dimension?: GPUTextureDimension;
  /** Additional view formats allowed for texture view creation. Defaults to none when omitted, matching WebGPU. */
  readonly viewFormats?: readonly GPUTextureFormat[];
  readonly label?: string;
}
