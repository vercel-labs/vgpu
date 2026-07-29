import { Texture, createResourceIdentity, DestroySignal, type Device, type ResourceDestroyCallback, type ResourceIdentity, type UnsubscribeResourceDestroy } from "@vgpu/core";
import type { RenderPassDescriptorOptions, Target, TargetOptions, TargetTextureOptions } from "./target.ts";
import { BUILT_IN_CLEAR_COLOR, colorAttachment, copyClearColor, colorSpecsFor, depthAttachment, depthFormatFor, sampleCountFor, sameSize, validateClearColor, validateTargetOptions, type ClearColor } from "./target-utils.ts";
import { liveKernel } from "./live-kernel.ts";
import type { Gpu } from "./kernel.ts";

/**
 * Offscreen render target: color attachments (plus optional depth and MSAA) sized in pixels.
 *
 * Its textures belong to the gpu's device, so `gpu.dispose()` releases them with the device; the
 * target is not registered as a separate kernel resource because there is nothing to tear down
 * ahead of the device — unlike a surface, which must unconfigure its canvas context first.
 */
export function target(gpu: Gpu, opts: TargetOptions): Target {
  return new OffscreenTarget(liveKernel(gpu, "target").device, opts);
}

/** Offscreen render target. MSAA targets render into sampleCount=4 attachments and resolve into `.color`. */
export class OffscreenTarget implements Target {
  readonly resourceIdentity = createResourceIdentity("render-target");
  readonly #destroySignal = new DestroySignal<Target>();
  readonly #texturesRecreatedCallbacks = new Set<() => void>();
  #currentSize: readonly [number, number];
  #currentColors: [Texture, ...Texture[]];
  #currentMsaaColors?: [Texture, ...Texture[]];
  #currentDepth?: Texture;
  #clearColor: ClearColor;

  constructor(private readonly device: Device, private readonly options: TargetOptions) {
    validateTargetOptions(options, device);
    this.#clearColor = options.clearColor === undefined ? BUILT_IN_CLEAR_COLOR : validateClearColor(options.clearColor, "target.clearColor");
    this.#currentSize = options.size;
    this.#currentColors = this.#createResolvedColors();
    this.#currentMsaaColors = this.sampleCount === 4 ? this.#createMsaaColors() : undefined;
    this.#currentDepth = this.#createDepth();
  }

  get gpu(): unknown { return this.color.gpu; }
  get size(): readonly [number, number] { return this.#currentSize; }
  get texelSize(): readonly [number, number] { return [1 / this.#currentSize[0], 1 / this.#currentSize[1]]; }
  /** Resolved, sampleable color texture. For MSAA targets, render passes resolve into this texture. */
  get color(): Texture { return this.#currentColors[0]; }
  /** Resolved, sampleable color textures. For MSAA targets, render passes resolve into these textures. */
  get colors(): readonly [Texture, ...Texture[]] { return this.#currentColors; }
  get depth(): Texture | undefined { return this.#currentDepth; }
  get format(): GPUTextureFormat { return colorSpecsFor(this.options)[0]?.format ?? "rgba8unorm"; }
  /** Default clear color of this target; passes that clear without naming a color use it. */
  get clearColor(): ClearColor { return copyClearColor(this.#clearColor); }
  set clearColor(value: ClearColor) { this.#clearColor = validateClearColor(value, "target.clearColor"); }
  get sampleCount(): 1 | 4 { return sampleCountFor(this.options); }

  resize(size: readonly [number, number]): void {
    if (sameSize(this.#currentSize, size)) return;
    this.#recreateTextures(size);
  }

  async read(): Promise<Uint8Array> { return this.color.read(); }
  async readFloats(): Promise<Float32Array> { return this.color.readFloats(); }
  onDestroy(cb: ResourceDestroyCallback<Target>): UnsubscribeResourceDestroy { return this.#destroySignal.onDestroy(this, cb); }
  onTexturesRecreated(cb: () => void): () => void { this.#texturesRecreatedCallbacks.add(cb); return () => { this.#texturesRecreatedCallbacks.delete(cb); }; }
  destroy(): void { this.#destroySignal.emit(this); this.#texturesRecreatedCallbacks.clear(); this.#destroyTextures(); }

  renderPassDescriptor(opts: RenderPassDescriptorOptions = {}): GPURenderPassDescriptor {
    const { clear = [0, 0, 0, 1], preserve, clearDepth, clearStencil, depthReadOnly } = opts;
    return {
      colorAttachments: this.#currentColors.map((resolved, index) => colorAttachment(resolved, this.#currentMsaaColors?.[index], clear, preserve)),
      depthStencilAttachment: this.#currentDepth ? depthAttachment(this.#currentDepth, preserve, clearDepth, clearStencil, depthReadOnly) : undefined,
    };
  }

  #recreateTextures(size: readonly [number, number]): void {
    this.#destroyTextures();
    this.#currentSize = [size[0], size[1]];
    this.#currentColors = this.#createResolvedColors();
    this.#currentMsaaColors = this.sampleCount === 4 ? this.#createMsaaColors() : undefined;
    this.#currentDepth = this.#createDepth();
    this.#emitTexturesRecreated();
  }

  #emitTexturesRecreated(): void {
    for (const cb of [...this.#texturesRecreatedCallbacks]) cb();
  }

  #destroyTextures(): void {
    for (const texture of this.#currentColors) texture.destroy();
    for (const texture of this.#currentMsaaColors ?? []) texture.destroy();
    this.#currentDepth?.destroy();
  }

  #createResolvedColors(): [Texture, ...Texture[]] {
    return colorSpecsFor(this.options).map((spec, index) => this.device.createTexture({
      size: this.#currentSize,
      format: spec.format,
      usage: ["render_attachment", "texture_binding", "copy_src"],
      sampleCount: 1,
      label: this.options.label ? `${this.options.label}.color${index}.resolve` : undefined,
    })) as [Texture, ...Texture[]];
  }

  #createMsaaColors(): [Texture, ...Texture[]] {
    return colorSpecsFor(this.options).map((spec, index) => this.device.createTexture({
      size: this.#currentSize,
      format: spec.format,
      usage: ["render_attachment"],
      sampleCount: 4,
      label: this.options.label ? `${this.options.label}.color${index}` : undefined,
    })) as [Texture, ...Texture[]];
  }

  #createDepth(): Texture | undefined {
    const format = depthFormatFor(this.options);
    // texture_binding lets read-only depth passes bind `target.depth` as a sampled texture in the same pass.
    return format ? this.device.createTexture({
      size: this.#currentSize,
      format,
      usage: ["render_attachment", "texture_binding"],
      sampleCount: this.sampleCount,
      label: this.options.label ? `${this.options.label}.depth` : undefined,
    }) : undefined;
  }
}
