import { Texture, createResourceIdentity, DestroySignal, type Device, type ResourceDestroyCallback, type ResourceIdentity, type UnsubscribeResourceDestroy } from "@vgpu/core";
import { unsupportedError } from "./errors.ts";

export interface TargetOptions {
  readonly size?: readonly [number, number];
  readonly format?: GPUTextureFormat;
  readonly colors?: readonly { readonly format: GPUTextureFormat }[];
  readonly depth?: boolean | GPUTextureFormat;
  readonly msaa?: boolean | 4;
  readonly label?: string;
}

export interface Target {
  readonly gpu: unknown;
  readonly size: readonly [number, number];
  readonly texelSize: readonly [number, number];
  readonly color: Texture;
  readonly colors: readonly [Texture, ...Texture[]];
  readonly depth?: Texture;
  readonly format: GPUTextureFormat;
  readonly sampleCount: 1 | 4;
  readonly resourceIdentity: ResourceIdentity;
  resize(size: readonly [number, number]): void;
  read(): Promise<Uint8Array>;
  onDestroy(cb: ResourceDestroyCallback<Target>): UnsubscribeResourceDestroy;
  renderPassDescriptor(clear?: GPUColor | readonly [number, number, number, number]): GPURenderPassDescriptor;
}

const DEFAULT_FORMAT: GPUTextureFormat = "rgba8unorm";

const MSAA_RENDERABLE_COLOR_FORMATS = new Set<GPUTextureFormat>([
  "rgba8unorm", "rgba8unorm-srgb", "rgba8snorm", "rgba8uint", "rgba8sint",
  "bgra8unorm", "bgra8unorm-srgb", "rgb10a2uint", "rgb10a2unorm",
]);

/** Offscreen render target. MSAA targets render into sampleCount=4 attachments and resolve into `.color`. */
export class OffscreenTarget implements Target {
  readonly resourceIdentity = createResourceIdentity("render-target");
  private readonly destroySignal = new DestroySignal<Target>();
  private currentSize: readonly [number, number];
  private currentColors: [Texture, ...Texture[]];
  private currentMsaaColors?: [Texture, ...Texture[]];
  private currentDepth?: Texture;

  constructor(private readonly device: Device, private readonly options: TargetOptions) {
    validateTargetOptions(options);
    this.currentSize = options.size ?? [1, 1];
    this.currentColors = this.createResolvedColors();
    this.currentMsaaColors = this.shouldMsaa() ? this.createMsaaColors() : undefined;
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
  get format(): GPUTextureFormat { return colorSpecsFor(this.options)[0]?.format ?? DEFAULT_FORMAT; }
  get sampleCount(): 1 | 4 { return this.shouldMsaa() ? 4 : 1; }

  resize(size: readonly [number, number]): void {
    if (sameSize(this.currentSize, size)) return;
    this.recreateTextures(size);
  }

  async read(): Promise<Uint8Array> { return this.color.read(); }
  onDestroy(cb: ResourceDestroyCallback<Target>): UnsubscribeResourceDestroy { return this.destroySignal.onDestroy(this, cb); }
  destroy(): void { this.destroySignal.emit(this); this.destroyTextures(); }

  renderPassDescriptor(clear: GPUColor | readonly [number, number, number, number] = [0, 0, 0, 1]): GPURenderPassDescriptor {
    return {
      colorAttachments: this.currentColors.map((resolved, index) => colorAttachment(resolved, this.currentMsaaColors?.[index], clear)),
      depthStencilAttachment: this.currentDepth ? depthAttachment(this.currentDepth) : undefined,
    };
  }

  private recreateTextures(size: readonly [number, number]): void {
    this.destroyTextures();
    this.currentSize = [size[0], size[1]];
    this.currentColors = this.createResolvedColors();
    this.currentMsaaColors = this.shouldMsaa() ? this.createMsaaColors() : undefined;
    this.currentDepth = this.createDepth();
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

  private shouldMsaa(): boolean { return this.options.msaa === true || this.options.msaa === 4; }
}

/** Canvas-backed target. Its `.color` wraps `getCurrentTexture()` and must be re-read each frame. */
export class ScreenTarget implements Target {
  readonly resourceIdentity = createResourceIdentity("render-target");
  private readonly destroySignal = new DestroySignal<Target>();
  constructor(private readonly context: GPUCanvasContext, private readonly device: Device, readonly format: GPUTextureFormat) {}
  get gpu(): unknown { return this.context; }
  get size(): readonly [number, number] { const canvas = this.context.canvas as { width: number; height: number }; return [canvas.width, canvas.height]; }
  get texelSize(): readonly [number, number] { return [1 / this.size[0], 1 / this.size[1]]; }
  get color(): Texture { return new Texture(this.device, this.context.getCurrentTexture(), { size: this.size, format: this.format, usage: ["render_attachment", "texture_binding", "copy_src"], label: "screen.color" }, "external"); }
  get colors(): readonly [Texture, ...Texture[]] { return [this.color]; }
  get depth(): undefined { return undefined; }
  get sampleCount(): 1 { return 1; }
  resize(_size: readonly [number, number]): void {}
  async read(): Promise<Uint8Array> { return this.color.read(); }
  onDestroy(cb: ResourceDestroyCallback<Target>): UnsubscribeResourceDestroy { return this.destroySignal.onDestroy(this, cb); }
  renderPassDescriptor(clear: GPUColor | readonly [number, number, number, number] = [0, 0, 0, 1]): GPURenderPassDescriptor {
    const clearValue = colorValue(clear);
    return { colorAttachments: [{ view: this.context.getCurrentTexture().createView(), loadOp: "clear", storeOp: "store", clearValue }] };
  }
}

function validateTargetOptions(options: TargetOptions): void {
  if (options.msaa !== true && options.msaa !== 4) return;
  for (const spec of colorSpecsFor(options)) validateMsaaFormat(spec.format);
}

function validateMsaaFormat(format: GPUTextureFormat): void {
  if (MSAA_RENDERABLE_COLOR_FORMATS.has(format)) return;
  throw unsupportedError(
    "gpu.target",
    `msaa: true no está soportado para el formato ${format}. WebGPU/Dawn no permite multisampling con este formato en esta fase.`,
    "Quitá `msaa` para mantener el target sampleable/HDR, o usá un formato multisample-capable como `rgba8unorm`.",
  );
}

function colorSpecsFor(options: TargetOptions): readonly { readonly format: GPUTextureFormat }[] {
  return options.colors ?? [{ format: options.format ?? DEFAULT_FORMAT }];
}

function depthFormatFor(options: TargetOptions): GPUTextureFormat | undefined {
  return options.depth === true ? "depth24plus" : options.depth || undefined;
}

function colorAttachment(resolved: Texture, msaa: Texture | undefined, clear: GPUColor | readonly [number, number, number, number]): GPURenderPassColorAttachment {
  return {
    view: (msaa ?? resolved).createView(),
    resolveTarget: msaa ? resolved.createView() : undefined,
    loadOp: "clear",
    storeOp: msaa ? "discard" : "store",
    clearValue: colorValue(clear),
  };
}

function depthAttachment(depth: Texture): GPURenderPassDepthStencilAttachment {
  return { view: depth.createView(), depthLoadOp: "clear", depthStoreOp: "store", depthClearValue: 1 };
}

function colorValue(clear: GPUColor | readonly [number, number, number, number]): GPUColor {
  return Array.isArray(clear) ? { r: clear[0], g: clear[1], b: clear[2], a: clear[3] } : clear;
}

function sameSize(a: readonly [number, number], b: readonly [number, number]): boolean {
  return a[0] === b[0] && a[1] === b[1];
}
