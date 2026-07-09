import { ValidationError } from "./errors.ts";
import { textureUsageFlags } from "./gpuConstants.ts";
import { isMockGPUTexture } from "./mock-gpu-storage.ts";
import type { Device } from "./device.ts";
import type { TextureOptions } from "./types.ts";

const textureBrand = Symbol.for("vgpu/Texture");

type TextureOwnership = "owned" | "external";

export class Texture {
  readonly [textureBrand] = true;
  private currentGpu: GPUTexture;
  private currentOptions: TextureOptions;
  private defaultView: GPUTextureView | null = null;
  private destroyed = false;

  constructor(
    private readonly device: Device,
    gpu: GPUTexture,
    options: TextureOptions,
    private readonly ownership: TextureOwnership = "owned",
  ) {
    this.currentGpu = gpu;
    this.currentOptions = options;
  }

  get gpu(): GPUTexture { return this.currentGpu; }
  get options(): TextureOptions { return this.currentOptions; }
  get size(): TextureOptions["size"] { return this.options.size; }
  get format(): GPUTextureFormat { return this.options.format; }
  get usage(): TextureOptions["usage"] { return this.options.usage; }
  get mipLevelCount(): number { return this.options.mipLevelCount ?? 1; }
  get sampleCount(): 1 | 4 { return this.options.sampleCount ?? 1; }
  get dimension(): GPUTextureDimension { return this.options.dimension ?? "2d"; }
  get viewFormats(): readonly GPUTextureFormat[] { return this.options.viewFormats ?? []; }
  get label(): string | undefined { return this.options.label; }

  get view(): GPUTextureView {
    this.assertAlive();
    this.defaultView ??= this.createView();
    return this.defaultView;
  }

  createView(desc?: GPUTextureViewDescriptor): GPUTextureView {
    return this.gpu.createView(desc);
  }

  resize(size: readonly [number, number] | readonly [number, number, number]): boolean {
    this.assertAlive();
    if (this.ownership === "external") {
      throw new ValidationError({
        code: "VGPU-CORE-EXTERNAL-TEXTURE",
        message: "Texture wraps an externally owned GPUTexture and cannot be resized.",
        where: "Texture.resize",
      });
    }

    const currentDepth = this.options.size[2] ?? 1;
    const nextDepth = size[2] ?? currentDepth;
    if (this.options.size[0] === size[0] && this.options.size[1] === size[1] && currentDepth === nextDepth) return false;

    const nextSize: TextureOptions["size"] = size[2] === undefined && this.options.size[2] === undefined
      ? [size[0], size[1]]
      : [size[0], size[1], nextDepth];
    const nextOptions: TextureOptions = { ...this.options, size: nextSize };
    const oldGpu = this.gpu;
    this.currentGpu = this.device.gpu.createTexture(toGPUTextureDescriptor(nextOptions));
    this.currentOptions = nextOptions;
    this.defaultView = null;
    oldGpu.destroy();
    return true;
  }

  async read(): Promise<Uint8Array> {
    this.assertAlive();
    if (isMockGPUTexture(this.gpu)) return this.gpu.__vgpuMockBytes.slice();
    return this.device.readback.readTexture(this.gpu, this.options.size, this.options.format);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.defaultView = null;
    if (!isMockGPUTexture(this.gpu)) this.gpu.destroy();
  }

  dispose(): void {
    this.destroy();
  }

  private assertAlive(): void {
    if (this.destroyed) throw new ValidationError({ code: "VGPU-CORE-TEXTURE-DESTROYED", message: "Texture is destroyed", where: "Texture" });
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
