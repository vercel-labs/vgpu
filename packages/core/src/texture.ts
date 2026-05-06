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
  return {
    label: opts.label,
    size: { width: opts.size[0], height: opts.size[1], depthOrArrayLayers: opts.size[2] ?? 1 },
    format: opts.format,
    usage: textureUsageFlags(opts.usage),
  };
}
