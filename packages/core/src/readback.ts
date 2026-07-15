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
    const encoder = this.device.createCommandEncoder();
    encoder.copyBufferToBuffer(source, offset, staging, 0, byteLength);
    this.device.queue.submit([encoder.finish()]);
    await staging.mapAsync(mapReadMode());
    const copy = staging.getMappedRange().slice(0);
    staging.unmap();
    staging.destroy();
    return copy;
  }

  async readTexture(texture: GPUTexture, size: readonly [number, number, number?], format: GPUTextureFormat): Promise<Uint8Array> {
    const [width, height] = size;
    const bytesPerPixel = formatBytesPerPixel(format);
    const bytesPerRow = align(width * bytesPerPixel, 256);
    const byteLength = bytesPerRow * height;
    const staging = this.device.createBuffer({ size: byteLength, usage: stagingUsage });
    const encoder = this.device.createCommandEncoder();
    encoder.copyTextureToBuffer({ texture }, { buffer: staging, bytesPerRow, rowsPerImage: height }, { width, height });
    this.device.queue.submit([encoder.finish()]);
    await staging.mapAsync(mapReadMode());
    const padded = new Uint8Array(staging.getMappedRange());
    const pixels = new Uint8Array(width * height * bytesPerPixel);
    for (let y = 0; y < height; y++) {
      const src = y * bytesPerRow;
      const dst = y * width * bytesPerPixel;
      pixels.set(padded.subarray(src, src + width * bytesPerPixel), dst);
    }
    staging.unmap();
    staging.destroy();
    return pixels;
  }

  destroy(): void {}
}

function align(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}

function formatBytesPerPixel(format: GPUTextureFormat): number {
  if (format === "rgba8unorm" || format === "rgba8unorm-srgb") return 4;
  throw new ValidationError({
    code: "VGPU-CORE-UNSUPPORTED-FORMAT",
    message: `Texture.read does not support format ${format}`,
    where: "Readback.readTexture",
  });
}
