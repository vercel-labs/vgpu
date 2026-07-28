import { ValidationError } from "./errors.ts";
import { bufferUsageFlags, mapReadMode } from "./gpu-constants.ts";
import { isMockGPUBuffer } from "./mock-gpu-storage.ts";

const stagingUsage = bufferUsageFlags(["copy_dst", "map_read"]);

export class Readback {
  constructor(private readonly device: GPUDevice) {}

  async read(source: GPUBuffer, byteLength: number, offset: number): Promise<ArrayBuffer> {
    if (isMockGPUBuffer(source)) {
      return source.__vgpuMockBytes.slice(offset, offset + byteLength).buffer;
    }

    const staging = this.device.createBuffer({
      size: byteLength,
      usage: stagingUsage,
    });
    // Every exit path destroys the staging buffer: on device loss mapAsync rejects (and unmap can throw),
    // and a skipped destroy would leak one buffer per read for the lifetime of the device.
    try {
      const encoder = this.device.createCommandEncoder();
      encoder.copyBufferToBuffer(source, offset, staging, 0, byteLength);
      this.device.queue.submit([encoder.finish()]);
      await staging.mapAsync(mapReadMode());
      const copy = staging.getMappedRange().slice(0);
      unmapQuietly(staging);
      return copy;
    } finally {
      destroyQuietly(staging);
    }
  }

  async readTexture(texture: GPUTexture, size: readonly [number, number, number?], format: GPUTextureFormat): Promise<Uint8Array> {
    const [width, height] = size;
    const formatInfo = textureReadbackFormat(format, "Readback.readTexture");
    const bytesPerPixel = formatInfo.bytesPerPixel;
    const bytesPerRow = align(width * bytesPerPixel, 256);
    const byteLength = bytesPerRow * height;
    const staging = this.device.createBuffer({ size: byteLength, usage: stagingUsage });
    // Same contract as read(): unmap is best-effort, destroy is guaranteed even when the device is lost.
    let pixels: Uint8Array;
    try {
      const encoder = this.device.createCommandEncoder();
      encoder.copyTextureToBuffer({ texture }, { buffer: staging, bytesPerRow, rowsPerImage: height }, { width, height });
      this.device.queue.submit([encoder.finish()]);
      await staging.mapAsync(mapReadMode());
      const padded = new Uint8Array(staging.getMappedRange());
      pixels = new Uint8Array(width * height * bytesPerPixel);
      for (let y = 0; y < height; y++) {
        const src = y * bytesPerRow;
        const dst = y * width * bytesPerPixel;
        pixels.set(padded.subarray(src, src + width * bytesPerPixel), dst);
      }
      unmapQuietly(staging);
    } finally {
      destroyQuietly(staging);
    }
    if (formatInfo.swizzle === "bgra-to-rgba") swizzleBgraToRgba(pixels);
    return pixels;
  }

  destroy(): void {}
}

/** Best-effort: a lost device rejects/throws on unmap, and the buffer is destroyed right after anyway. */
function unmapQuietly(buffer: GPUBuffer): void {
  try { buffer.unmap(); }
  catch { /* device lost or already unmapped: destroy still releases the buffer */ }
}

/** Guaranteed release: never let a cleanup failure replace the original error (or the returned data). */
function destroyQuietly(buffer: GPUBuffer): void {
  try { buffer.destroy(); }
  catch { /* device lost: the buffer dies with the device */ }
}

function align(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}

/** How one component of a readable texture format is stored in the bytes `readTexture` returns. */
export type TextureComponentType = "unorm8" | "float16" | "float32";

export interface TextureReadbackFormatInfo {
  /** Size of one texel in the copied bytes. */
  readonly bytesPerPixel: number;
  /** Components per texel (1 for `r*`, 2 for `rg*`, 4 for `rgba*`/`bgra*`). */
  readonly components: number;
  readonly componentType: TextureComponentType;
  /** Present when the copied bytes are reordered to RGBA channel order. */
  readonly swizzle?: "bgra-to-rgba";
}

/**
 * Every color format `Texture.read()` / `Texture.readFloats()` can copy back. Depth/stencil,
 * packed (`rgb10a2unorm`, `rg11b10ufloat`, ...), snorm/uint/sint, and compressed formats are
 * intentionally absent: they need aspect selection or a decode that has no single obvious answer.
 */
const readbackFormats = {
  "r8unorm": { bytesPerPixel: 1, components: 1, componentType: "unorm8" },
  "rg8unorm": { bytesPerPixel: 2, components: 2, componentType: "unorm8" },
  "rgba8unorm": { bytesPerPixel: 4, components: 4, componentType: "unorm8" },
  "rgba8unorm-srgb": { bytesPerPixel: 4, components: 4, componentType: "unorm8" },
  "bgra8unorm": { bytesPerPixel: 4, components: 4, componentType: "unorm8", swizzle: "bgra-to-rgba" },
  "bgra8unorm-srgb": { bytesPerPixel: 4, components: 4, componentType: "unorm8", swizzle: "bgra-to-rgba" },
  "r16float": { bytesPerPixel: 2, components: 1, componentType: "float16" },
  "rg16float": { bytesPerPixel: 4, components: 2, componentType: "float16" },
  "rgba16float": { bytesPerPixel: 8, components: 4, componentType: "float16" },
  "r32float": { bytesPerPixel: 4, components: 1, componentType: "float32" },
  "rg32float": { bytesPerPixel: 8, components: 2, componentType: "float32" },
  "rgba32float": { bytesPerPixel: 16, components: 4, componentType: "float32" },
} as const satisfies Partial<Record<GPUTextureFormat, TextureReadbackFormatInfo>>;

/** Color formats supported by texture readback. */
export type ReadableTextureFormat = keyof typeof readbackFormats;

/** Readback layout for `format`, or `VGPU-CORE-UNSUPPORTED-FORMAT` when the format cannot be read back. */
export function textureReadbackFormat(format: GPUTextureFormat, where: string): TextureReadbackFormatInfo {
  const info = (readbackFormats as Partial<Record<GPUTextureFormat, TextureReadbackFormatInfo>>)[format];
  if (info) return info;
  throw new ValidationError({
    code: "VGPU-CORE-UNSUPPORTED-FORMAT",
    message: `Texture.read does not support format ${format}. Supported formats: ${Object.keys(readbackFormats).join(", ")}.`,
    where,
  });
}

/**
 * Decodes readback bytes into one f32 per component, in the same row-major component order.
 * `unorm8` components are normalized to `[0, 1]` (srgb formats keep their encoded value: no
 * gamma conversion), `float16` components are widened to f32, `float32` components are copied.
 */
export function decodeTextureFloats(bytes: Uint8Array, format: GPUTextureFormat, where = "Texture.readFloats"): Float32Array {
  const info = textureReadbackFormat(format, where);
  const bytesPerComponent = info.bytesPerPixel / info.components;
  const count = Math.floor(bytes.byteLength / bytesPerComponent);
  const floats = new Float32Array(count);
  // DataView over the exact view range: readback bytes are not guaranteed to be 2/4-byte aligned.
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < count; i++) {
    if (info.componentType === "unorm8") floats[i] = view.getUint8(i) / 255;
    else if (info.componentType === "float16") floats[i] = halfToFloat(view.getUint16(i * 2, true));
    else floats[i] = view.getFloat32(i * 4, true);
  }
  return floats;
}

/** IEEE-754 binary16 -> binary32, including subnormals, infinities, and NaN. */
function halfToFloat(bits: number): number {
  const sign = bits & 0x8000 ? -1 : 1;
  const exponent = (bits >> 10) & 0x1f;
  const mantissa = bits & 0x3ff;
  if (exponent === 0) return sign * mantissa * 2 ** -24;
  if (exponent === 0x1f) return mantissa === 0 ? sign * Number.POSITIVE_INFINITY : Number.NaN;
  return sign * (mantissa + 1024) * 2 ** (exponent - 25);
}

/**
 * Mock-texture equivalent of `readTexture`: mock storage is tightly packed in the texture's own
 * format and holds every layer, so take layer 0 (what `copyTextureToBuffer` copies for a
 * `[width, height]` extent) and apply the same channel swizzle a real copy does.
 * Callers pass an already validated layout, so mock and real devices reject the same formats.
 */
export function readMockTextureBytes(stored: Uint8Array, size: readonly [number, number, number?], info: TextureReadbackFormatInfo): Uint8Array {
  const pixels = stored.slice(0, size[0] * size[1] * info.bytesPerPixel);
  if (info.swizzle === "bgra-to-rgba") swizzleBgraToRgba(pixels);
  return pixels;
}

function swizzleBgraToRgba(pixels: Uint8Array): void {
  for (let i = 0; i < pixels.length; i += 4) {
    const b = pixels[i]!;
    pixels[i] = pixels[i + 2]!;
    pixels[i + 2] = b;
  }
}
