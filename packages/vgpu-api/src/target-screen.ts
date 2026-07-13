import { Texture, createResourceIdentity, DestroySignal, type Device, type ResourceDestroyCallback, type ResourceIdentity, type UnsubscribeResourceDestroy } from "@vgpu/core";
import type { Target } from "./target.ts";
import { colorValue, sameSize } from "./target-utils.ts";

/** Canvas-backed target. Its `.color` wraps `getCurrentTexture()` and must be re-read each frame. */
export class ScreenTarget implements Target {
  readonly resourceIdentity = createResourceIdentity("render-target");
  private readonly destroySignal = new DestroySignal<Target>();

  constructor(
    private readonly context: GPUCanvasContext,
    private readonly device: Device,
    readonly format: GPUTextureFormat,
    private readonly notifyResize: (size: readonly [number, number]) => void = () => undefined,
  ) {}

  get gpu(): unknown { return this.context; }
  get size(): readonly [number, number] { return canvasSize(this.context.canvas); }
  get texelSize(): readonly [number, number] { return [1 / this.size[0], 1 / this.size[1]]; }
  get color(): Texture { return new Texture(this.device, this.context.getCurrentTexture(), { size: this.size, format: this.format, usage: ["render_attachment", "texture_binding", "copy_src"], label: "screen.color" }, "external"); }
  get colors(): readonly [Texture, ...Texture[]] { return [this.color]; }
  get depth(): undefined { return undefined; }
  get sampleCount(): 1 { return 1; }

  resize(size: readonly [number, number]): void {
    if (sameSize(this.size, size)) return;
    const canvas = this.context.canvas as { width: number; height: number };
    canvas.width = size[0];
    canvas.height = size[1];
    this.notifyResize(size);
  }

  async read(): Promise<Uint8Array> { return this.color.read(); }
  onDestroy(cb: ResourceDestroyCallback<Target>): UnsubscribeResourceDestroy { return this.destroySignal.onDestroy(this, cb); }
  renderPassDescriptor(clear: GPUColor | readonly [number, number, number, number] = [0, 0, 0, 1]): GPURenderPassDescriptor {
    return { colorAttachments: [{ view: this.context.getCurrentTexture().createView(), loadOp: "clear", storeOp: "store", clearValue: colorValue(clear) }] };
  }
}

function canvasSize(canvasLike: unknown): readonly [number, number] {
  const canvas = canvasLike as { width: number; height: number };
  return [canvas.width, canvas.height];
}
