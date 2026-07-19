import { Texture, createResourceIdentity, DestroySignal, type Device, type ResourceDestroyCallback, type ResourceIdentity, type UnsubscribeResourceDestroy } from "@vgpu/core";
import type { Target, TargetOptions, TargetTextureOptions } from "./target.ts";
import { colorAttachment, colorSpecsFor, depthAttachment, depthFormatFor, sampleCountFor, sameSize, validateTargetOptions, type ClearColor } from "./target-utils.ts";

/** Offscreen render target. MSAA targets render into sampleCount=4 attachments and resolve into `.color`. */
export class OffscreenTarget implements Target {
  readonly resourceIdentity = createResourceIdentity("render-target");
  private readonly destroySignal = new DestroySignal<Target>();
  private readonly texturesRecreatedCallbacks = new Set<() => void>();
  private currentSize: readonly [number, number];
  private currentColors: [Texture, ...Texture[]];
  private currentMsaaColors?: [Texture, ...Texture[]];
  private currentDepth?: Texture;

  constructor(private readonly device: Device, private readonly options: TargetOptions) {
    validateTargetOptions(options, device);
    this.currentSize = options.size;
    this.currentColors = this.createResolvedColors();
    this.currentMsaaColors = this.sampleCount === 4 ? this.createMsaaColors() : undefined;
    this.currentDepth = this.createDepth();
  }

  get gpu(): unknown { return this.color.gpu; }
  get size(): readonly [number, number] { return this.currentSize; }
  get texelSize(): readonly [number, number] { return [1 / this.currentSize[0], 1 / this.currentSize[1]]; }
  /** Resolved, sampleable color texture. For MSAA targets, render passes resolve into this texture. */
  get color(): Texture { return this.currentColors[0]; }
  /** Resolved, sampleable color textures. For MSAA targets, render passes resolve into these textures. */
  get colors(): readonly [Texture, ...Texture[]] { return this.currentColors; }
  get depth(): Texture | undefined { return this.currentDepth; }
  get format(): GPUTextureFormat { return colorSpecsFor(this.options)[0]?.format ?? "rgba8unorm"; }
  get sampleCount(): 1 | 4 { return sampleCountFor(this.options); }

  resize(size: readonly [number, number]): void {
    if (sameSize(this.currentSize, size)) return;
    this.recreateTextures(size);
  }

  async read(): Promise<Uint8Array> { return this.color.read(); }
  onDestroy(cb: ResourceDestroyCallback<Target>): UnsubscribeResourceDestroy { return this.destroySignal.onDestroy(this, cb); }
  onTexturesRecreated(cb: () => void): () => void { this.texturesRecreatedCallbacks.add(cb); return () => { this.texturesRecreatedCallbacks.delete(cb); }; }
  destroy(): void { this.destroySignal.emit(this); this.texturesRecreatedCallbacks.clear(); this.destroyTextures(); }

  renderPassDescriptor(clear: ClearColor = [0, 0, 0, 1], preserve?: boolean): GPURenderPassDescriptor {
    return {
      colorAttachments: this.currentColors.map((resolved, index) => colorAttachment(resolved, this.currentMsaaColors?.[index], clear, preserve)),
      depthStencilAttachment: this.currentDepth ? depthAttachment(this.currentDepth, preserve) : undefined,
    };
  }

  private recreateTextures(size: readonly [number, number]): void {
    this.destroyTextures();
    this.currentSize = [size[0], size[1]];
    this.currentColors = this.createResolvedColors();
    this.currentMsaaColors = this.sampleCount === 4 ? this.createMsaaColors() : undefined;
    this.currentDepth = this.createDepth();
    this.emitTexturesRecreated();
  }

  private emitTexturesRecreated(): void {
    for (const cb of [...this.texturesRecreatedCallbacks]) cb();
  }

  private destroyTextures(): void {
    for (const texture of this.currentColors) texture.destroy();
    for (const texture of this.currentMsaaColors ?? []) texture.destroy();
    this.currentDepth?.destroy();
  }

  private createResolvedColors(): [Texture, ...Texture[]] {
    return colorSpecsFor(this.options).map((spec, index) => this.device.createTexture({
      size: this.currentSize,
      format: spec.format,
      usage: ["render_attachment", "texture_binding", "copy_src"],
      sampleCount: 1,
      label: this.options.label ? `${this.options.label}.color${index}.resolve` : undefined,
    })) as [Texture, ...Texture[]];
  }

  private createMsaaColors(): [Texture, ...Texture[]] {
    return colorSpecsFor(this.options).map((spec, index) => this.device.createTexture({
      size: this.currentSize,
      format: spec.format,
      usage: ["render_attachment"],
      sampleCount: 4,
      label: this.options.label ? `${this.options.label}.color${index}` : undefined,
    })) as [Texture, ...Texture[]];
  }

  private createDepth(): Texture | undefined {
    const format = depthFormatFor(this.options);
    return format ? this.device.createTexture({
      size: this.currentSize,
      format,
      usage: ["render_attachment"],
      sampleCount: this.sampleCount,
      label: this.options.label ? `${this.options.label}.depth` : undefined,
    }) : undefined;
  }
}
