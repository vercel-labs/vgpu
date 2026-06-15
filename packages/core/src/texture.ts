import { textureUsageFlags } from "./gpuConstants.ts";
import { isMockGPUTexture } from "./mock-gpu-storage.ts";
import type { Device } from "./device.ts";
import type { TextureOptions } from "./types.ts";

const textureBrand = Symbol.for("vgpu/Texture");

export class Texture {
  readonly [textureBrand] = true;
  private destroyed = false;

  constructor(
    private readonly device: Device,
    readonly gpu: GPUTexture,
    readonly options: TextureOptions,
  ) {}

  get size(): TextureOptions["size"] { return this.options.size; }
  get format(): GPUTextureFormat { return this.options.format; }
  get usage(): TextureOptions["usage"] { return this.options.usage; }
  get mipLevelCount(): number { return this.options.mipLevelCount ?? 1; }
  get sampleCount(): 1 | 4 { return this.options.sampleCount ?? 1; }
  get dimension(): GPUTextureDimension { return this.options.dimension ?? "2d"; }
  get viewFormats(): readonly GPUTextureFormat[] { return this.options.viewFormats ?? []; }
  get label(): string | undefined { return this.options.label; }

  createView(desc?: GPUTextureViewDescriptor): GPUTextureView {
    return this.gpu.createView(desc);
  }

  async read(): Promise<Uint8Array> {
    this.assertAlive();
    if (isMockGPUTexture(this.gpu)) return this.gpu.__vgpuMockBytes.slice();
    return this.device.readback.readTexture(this.gpu, this.options.size, this.options.format);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (!isMockGPUTexture(this.gpu)) this.gpu.destroy();
  }

  dispose(): void {
    this.destroy();
  }

  private assertAlive(): void {
    if (this.destroyed) throw new Error("Texture is destroyed");
  }
}

export function toGPUTextureDescriptor(opts: TextureOptions): GPUTextureDescriptor {
  const desc: GPUTextureDescriptor = {
    label: opts.label,
    size: { width: opts.size[0], height: opts.size[1], depthOrArrayLayers: opts.size[2] ?? 1 },
    format: opts.format,
    usage: textureUsageFlags(opts.usage),
  };
  if (opts.mipLevelCount !== undefined) desc.mipLevelCount = opts.mipLevelCount;
  if (opts.sampleCount !== undefined) desc.sampleCount = opts.sampleCount;
  if (opts.dimension !== undefined) desc.dimension = opts.dimension;
  if (opts.viewFormats !== undefined) desc.viewFormats = [...opts.viewFormats];
  return desc;
}
