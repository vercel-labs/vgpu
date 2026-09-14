import { ValidationError } from "./errors.ts";
import { textureUsageFlags } from "./gpu-constants.ts";
import { isMockGPUTexture } from "./mock-gpu-storage.ts";
import { decodeTextureFloats, textureReadbackFormat } from "./readback.ts";
import { textureReadSelection, validateReadAllocation } from "./texture-read-selection.ts";
import { createResourceIdentity, DestroySignal, type ResourceDestroyCallback, type ResourceIdentity, type UnsubscribeResourceDestroy } from "./resource-lifecycle.ts";
import type { Device } from "./device.ts";
import type { TextureOptions, TextureReadOptions } from "./types.ts";
import { snapshotTextureOptions, textureExtent } from "./texture-options.ts";

const textureBrand = Symbol.for("vgpu/Texture");

type TextureOwnership = "owned" | "external";

export class Texture {
  readonly [textureBrand] = true;
  private readonly destroySignal = new DestroySignal<Texture>();
  private readonly identity = createResourceIdentity("texture");
  private readonly currentGpu: GPUTexture;
  private readonly currentOptions: TextureOptions;
  private defaultView: GPUTextureView | null = null;
  private destroyed = false;

  constructor(
    private readonly device: Device,
    gpu: GPUTexture,
    options: TextureOptions,
    private readonly ownership: TextureOwnership = "owned",
  ) {
    this.currentGpu = gpu;
    this.currentOptions = snapshotTextureOptions(options);
  }

  get gpu(): GPUTexture { return this.currentGpu; }
  get options(): TextureOptions { return this.currentOptions; }
  get size(): TextureOptions["size"] { return this.options.size; }
  get format(): GPUTextureFormat { return this.options.format; }
  get usage(): TextureOptions["usage"] { return this.options.usage; }
  get mipLevelCount(): number { return this.options.mipLevelCount ?? 1; }
  get sampleCount(): 1 | 4 { return this.options.sampleCount ?? 1; }
  get kind(): TextureOptions["kind"] { return this.options.kind; }
  get layers(): number { return this.options.kind === "2d-array" ? this.options.layers : 1; }
  /** Native dimension retained for low-level interop; kind distinguishes arrays. */
  get dimension(): GPUTextureDimension { return this.options.kind === "2d-array" ? "2d" : this.options.kind; }
  get viewFormats(): readonly GPUTextureFormat[] { return this.options.viewFormats ?? []; }
  get label(): string | undefined { return this.options.label; }
  get resourceIdentity(): ResourceIdentity { return this.identity; }

  onDestroy(cb: ResourceDestroyCallback<Texture>): UnsubscribeResourceDestroy {
    return this.destroySignal.onDestroy(this, cb);
  }

  get view(): GPUTextureView {
    this.assertAlive();
    this.defaultView ??= this.createView();
    return this.defaultView;
  }

  createView(desc?: GPUTextureViewDescriptor): GPUTextureView {
    this.assertAlive("Texture.createView");
    // A one-layer array is still an array in the semantic API. Native WebGPU otherwise
    // infers a 2D view; callers can explicitly request that with dimension: "2d".
    return this.gpu.createView(this.kind === "2d-array" ? { ...desc, dimension: desc?.dimension ?? "2d-array" } : desc);
  }

  /**
   * Raw, unpadded texel bytes in this texture's own format (row stride padding removed).
   * Tightly packed X, then Y, then Z across the selected mip region; `bgra*` is swizzled to RGBA.
   * Use `readFloats()` for float formats to get decoded component values.
   */
  async read(options: TextureReadOptions): Promise<Uint8Array> {
    this.assertAlive("Texture.read");
    const result = await this.device.readback.readTexture(this.gpu, options);
    // Re-checked after the await: a retained external device can be destroyed mid-readback.
    this.assertAlive("Texture.read");
    return result;
  }

  /**
   * Selected texel components decoded to f32, tightly packed in X/Y/Z order.
   * `float16`/`float32` formats keep their HDR values (no clamping); `unorm8` formats are
   * normalized to `[0, 1]` without srgb gamma conversion.
   */
  async readFloats(options: TextureReadOptions): Promise<Float32Array> {
    // Validate before the copy so an unsupported format never allocates a staging buffer.
    this.assertAlive("Texture.readFloats");
    const info = textureReadbackFormat(this.options.format, "Texture.readFloats");
    const { size } = textureReadSelection(this.gpu, options, "Texture.readFloats");
    validateReadAllocation(size[0] * size[1] * size[2] * info.components * 4, this.device.gpu.limits?.maxBufferSize, "Texture.readFloats");
    return decodeTextureFloats(await this.read(options), this.options.format);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.defaultView = null;
    try { this.destroySignal.emit(this); }
    finally {
      if (this.ownership !== "external" && !isMockGPUTexture(this.gpu)) this.gpu.destroy();
    }
  }

  dispose(): void {
    this.destroy();
  }

  private assertAlive(where = "Texture"): void {
    if (this.destroyed) throw new ValidationError({ code: "VGPU-CORE-TEXTURE-DESTROYED", message: "Texture is destroyed", where });
    (this.device as unknown as { assertUsable?(where: string): void }).assertUsable?.(where);
  }
}

export function toGPUTextureDescriptor(opts: TextureOptions): GPUTextureDescriptor {
  const [width, height, depthOrArrayLayers] = textureExtent(opts);
  const desc: GPUTextureDescriptor = {
    label: opts.label,
    size: { width, height, depthOrArrayLayers },
    dimension: opts.kind === "2d-array" ? "2d" : opts.kind,
    format: opts.format,
    usage: textureUsageFlags(opts.usage),
  };
  if (opts.mipLevelCount !== undefined) desc.mipLevelCount = opts.mipLevelCount;
  if (opts.sampleCount !== undefined) desc.sampleCount = opts.sampleCount;
  if (opts.viewFormats !== undefined) desc.viewFormats = [...opts.viewFormats];
  // Compatibility mode otherwise infers 2D for a one-layer array, preventing array bindings.
  if (opts.kind === "2d-array") desc.textureBindingViewDimension = "2d-array";
  return desc;
}
