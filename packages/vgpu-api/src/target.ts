import { Texture, createResourceIdentity, DestroySignal, type Device, type ResourceDestroyCallback, type ResourceIdentity, type UnsubscribeResourceDestroy } from "@vgpu/core";

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

export class OffscreenTarget implements Target {
  readonly resourceIdentity = createResourceIdentity("render-target");
  private readonly destroySignal = new DestroySignal<Target>();
  private currentSize: readonly [number, number];
  private currentColors: [Texture, ...Texture[]];
  private currentDepth?: Texture;

  constructor(private readonly device: Device, private readonly options: TargetOptions) {
    this.currentSize = options.size ?? [1, 1];
    this.currentColors = this.createColors();
    this.currentDepth = this.createDepth();
  }

  get gpu(): unknown { return this.currentColors[0]?.gpu; }
  get size(): readonly [number, number] { return this.currentSize; }
  get texelSize(): readonly [number, number] { return [1 / this.currentSize[0], 1 / this.currentSize[1]]; }
  get color(): Texture { return this.currentColors[0]; }
  get colors(): readonly [Texture, ...Texture[]] { return this.currentColors; }
  get depth(): Texture | undefined { return this.currentDepth; }
  get format(): GPUTextureFormat { return this.options.colors?.[0]?.format ?? this.options.format ?? DEFAULT_FORMAT; }
  get sampleCount(): 1 | 4 { return 1; }

  resize(size: readonly [number, number]): void {
    if (this.currentSize[0] === size[0] && this.currentSize[1] === size[1]) return;
    for (const texture of this.currentColors) texture.destroy();
    this.currentDepth?.destroy();
    this.currentSize = [size[0], size[1]];
    this.currentColors = this.createColors();
    this.currentDepth = this.createDepth();
  }

  async read(): Promise<Uint8Array> { return this.color.read(); }
  onDestroy(cb: ResourceDestroyCallback<Target>): UnsubscribeResourceDestroy { return this.destroySignal.onDestroy(this, cb); }
  destroy(): void { this.destroySignal.emit(this); for (const texture of this.currentColors) texture.destroy(); this.currentDepth?.destroy(); }

  renderPassDescriptor(clear: GPUColor | readonly [number, number, number, number] = [0, 0, 0, 1]): GPURenderPassDescriptor {
    const clearValue = Array.isArray(clear) ? { r: clear[0], g: clear[1], b: clear[2], a: clear[3] } : clear;
    return {
      colorAttachments: this.currentColors.map((texture) => ({ view: texture.createView(), loadOp: "clear" as const, storeOp: "store" as const, clearValue })),
      depthStencilAttachment: this.currentDepth ? { view: this.currentDepth.createView(), depthLoadOp: "clear", depthStoreOp: "store", depthClearValue: 1 } : undefined,
    };
  }

  private createColors(): [Texture, ...Texture[]] {
    const specs = this.options.colors ?? [{ format: this.options.format ?? DEFAULT_FORMAT }];
    return specs.map((spec, index) => this.device.createTexture({
      size: this.currentSize,
      format: spec.format,
      usage: ["render_attachment", "texture_binding", "copy_src"],
      label: this.options.label ? `${this.options.label}.color${index}` : undefined,
    })) as [Texture, ...Texture[]];
  }

  private createDepth(): Texture | undefined {
    const format = this.options.depth === true ? "depth24plus" : this.options.depth || undefined;
    return format ? this.device.createTexture({ size: this.currentSize, format, usage: ["render_attachment"], label: this.options.label ? `${this.options.label}.depth` : undefined }) : undefined;
  }
}

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
    const clearValue = Array.isArray(clear) ? { r: clear[0], g: clear[1], b: clear[2], a: clear[3] } : clear;
    return { colorAttachments: [{ view: this.context.getCurrentTexture().createView(), loadOp: "clear", storeOp: "store", clearValue }] };
  }
}
