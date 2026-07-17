import { Texture, createResourceIdentity, DestroySignal, type Device, type ResourceDestroyCallback, type ResourceIdentity, type UnsubscribeResourceDestroy } from "@vgpu/core";
import { colorValue, sameSize } from "./target-utils.ts";
import type { Target } from "./target.ts";
import {
  surfaceAutoResizeUnsupportedError,
  surfaceContextError,
  surfaceDisposedError,
  surfaceResizeReentrantError,
} from "./errors.ts";

export interface SurfaceOptions {
  readonly autoResize?: boolean;
  readonly dpr?: number | readonly [number, number];
  readonly size?: readonly [number, number];
  readonly format?: GPUTextureFormat;
  readonly alphaMode?: GPUCanvasAlphaMode;
  readonly colorSpace?: PredefinedColorSpace;
  readonly label?: string;
}

export interface SurfaceResizeEvent {
  readonly width: number;
  readonly height: number;
  readonly dpr: number;
  readonly surface: Surface;
}

export interface Surface extends Target {
  readonly canvas: HTMLCanvasElement | OffscreenCanvas;
  readonly context: GPUCanvasContext;
  readonly autoResize: boolean;
  readonly layoutBacked: boolean;
  readonly dpr: number;
  readonly disposed: boolean;
  onResize(cb: (event: SurfaceResizeEvent) => void): () => void;
  dispose(): void;
}

export type SurfaceCanvas = HTMLCanvasElement | OffscreenCanvas;

let resizeCallbackDepth = 0;
export function isSurfaceResizeCallbackActive(): boolean { return resizeCallbackDepth > 0; }

export class CanvasSurface implements Surface {
  readonly resourceIdentity = createResourceIdentity("render-target");
  readonly label: string | undefined;
  readonly context: GPUCanvasContext;
  readonly autoResize: boolean;
  readonly layoutBacked: boolean;
  readonly format: GPUTextureFormat;
  private readonly destroySignal = new DestroySignal<Target>();
  private readonly callbacks = new Set<(event: SurfaceResizeEvent) => void>();
  private readonly texturesRecreatedCallbacks = new Set<() => void>();
  private currentDpr: number;
  private isDisposed = false;
  private notifying = false;

  constructor(
    private readonly device: Device,
    readonly canvas: SurfaceCanvas,
    private readonly options: SurfaceOptions,
    private readonly unregister: (surface: CanvasSurface) => void,
  ) {
    this.label = options.label;
    const context = canvas.getContext("webgpu") as GPUCanvasContext | null;
    if (!context) throw surfaceContextError();
    this.context = context;
    this.layoutBacked = isLayoutBacked(canvas);
    if (options.autoResize === true && !this.layoutBacked) throw surfaceAutoResizeUnsupportedError();
    this.autoResize = options.autoResize ?? (options.size ? false : this.layoutBacked);
    this.currentDpr = effectiveDpr(options.dpr);
    this.format = options.format ?? preferredCanvasFormat();
    const initialSize = initialCanvasSize(canvas, options, this.layoutBacked, this.currentDpr);
    if (options.size || this.layoutBacked) setCanvasSize(canvas, initialSize);
    context.configure({
      device: device.gpu,
      format: this.format,
      alphaMode: options.alphaMode ?? "premultiplied",
      colorSpace: options.colorSpace ?? "srgb",
      usage: canvasTextureUsage(),
    });
  }

  get gpu(): unknown { return this.context; }
  get size(): readonly [number, number] { this.assertLive(); return canvasSize(this.canvas); }
  get texelSize(): readonly [number, number] { const size = this.size; return [1 / size[0], 1 / size[1]]; }
  get color(): Texture {
    this.assertLive();
    return new Texture(this.device, this.context.getCurrentTexture(), {
      size: this.size,
      format: this.format,
      usage: ["render_attachment", "texture_binding", "copy_src"],
      label: this.options.label ? `${this.options.label}.color` : "surface.color",
    }, "external");
  }
  get colors(): readonly [Texture, ...Texture[]] { return [this.color]; }
  get depth(): undefined { this.assertLive(); return undefined; }
  get sampleCount(): 1 { this.assertLive(); return 1; }
  get dpr(): number { return this.currentDpr; }
  get disposed(): boolean { return this.isDisposed; }

  resize(size: readonly [number, number]): void {
    this.assertLive();
    if (this.notifying) throw surfaceResizeReentrantError(this.options.label);
    this.applyResize(sanitizeSize(size), this.currentDpr, true);
  }

  applyAutoResize(): void {
    if (this.isDisposed || !this.autoResize || !this.layoutBacked) return;
    const nextDpr = effectiveDpr(this.options.dpr);
    const nextSize = layoutCanvasSize(this.canvas, nextDpr);
    this.applyResize(nextSize, nextDpr, true);
  }

  onResize(cb: (event: SurfaceResizeEvent) => void): () => void {
    this.assertLive();
    this.callbacks.add(cb);
    this.notifying = true;
    resizeCallbackDepth += 1;
    try { cb(this.event()); }
    finally { resizeCallbackDepth -= 1; this.notifying = false; }
    return () => { this.callbacks.delete(cb); };
  }

  async read(): Promise<Uint8Array> { this.assertLive(); return this.color.read(); }
  onDestroy(cb: ResourceDestroyCallback<Target>): UnsubscribeResourceDestroy { this.assertLive(); return this.destroySignal.onDestroy(this, cb); }
  onTexturesRecreated(cb: () => void): () => void { this.assertLive(); this.texturesRecreatedCallbacks.add(cb); return () => { this.texturesRecreatedCallbacks.delete(cb); }; }

  renderPassDescriptor(clear: GPUColor | readonly [number, number, number, number] = [0, 0, 0, 1]): GPURenderPassDescriptor {
    this.assertLive();
    return { colorAttachments: [{ view: this.context.getCurrentTexture().createView(), loadOp: "clear", storeOp: "store", clearValue: colorValue(clear) }] };
  }

  dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;
    try { this.context.unconfigure?.(); } catch { /* ignore native cleanup failures */ }
    this.unregister(this);
    this.callbacks.clear();
    this.texturesRecreatedCallbacks.clear();
    this.destroySignal.emit(this);
  }

  private applyResize(size: readonly [number, number], dpr: number, notify: boolean): void {
    const changed = !sameSize(canvasSize(this.canvas), size);
    this.currentDpr = dpr;
    if (!changed) return;
    setCanvasSize(this.canvas, size);
    this.emitTexturesRecreated();
    if (notify) this.notify();
  }

  private emitTexturesRecreated(): void {
    for (const cb of [...this.texturesRecreatedCallbacks]) cb();
  }

  private notify(): void {
    this.notifying = true;
    resizeCallbackDepth += 1;
    try {
      const event = this.event();
      for (const cb of [...this.callbacks]) cb(event);
    } finally {
      resizeCallbackDepth -= 1;
      this.notifying = false;
    }
  }

  private event(): SurfaceResizeEvent {
    const size = canvasSize(this.canvas);
    return { width: size[0], height: size[1], dpr: this.currentDpr, surface: this };
  }

  private assertLive(): void {
    if (this.isDisposed) throw surfaceDisposedError(this.options.label);
  }
}

export function isLayoutBacked(canvas: unknown): boolean {
  return typeof (canvas as { clientWidth?: unknown }).clientWidth === "number";
}

function initialCanvasSize(canvas: SurfaceCanvas, options: SurfaceOptions, layoutBacked: boolean, dpr: number): readonly [number, number] {
  if (options.size) return sanitizeSize(options.size);
  if (layoutBacked) return layoutCanvasSize(canvas, dpr);
  return sanitizeSize(canvasSize(canvas));
}

function layoutCanvasSize(canvasLike: unknown, dpr: number): readonly [number, number] {
  const canvas = canvasLike as { clientWidth: number; clientHeight: number };
  return sanitizeSize([Math.round(canvas.clientWidth * dpr), Math.round(canvas.clientHeight * dpr)]);
}

function canvasSize(canvasLike: unknown): readonly [number, number] {
  const canvas = canvasLike as { width: number; height: number };
  return [canvas.width, canvas.height];
}

function setCanvasSize(canvasLike: unknown, size: readonly [number, number]): void {
  const canvas = canvasLike as { width: number; height: number };
  canvas.width = size[0];
  canvas.height = size[1];
}

function sanitizeSize(size: readonly [number, number]): readonly [number, number] {
  return [Math.max(1, Math.floor(size[0])), Math.max(1, Math.floor(size[1]))];
}

function effectiveDpr(dpr: SurfaceOptions["dpr"]): number {
  const raw = globalThis.devicePixelRatio ?? 1;
  if (Array.isArray(dpr)) return Math.min(dpr[1], Math.max(dpr[0], raw));
  if (typeof dpr === "number") return dpr;
  return raw;
}

function preferredCanvasFormat(): GPUTextureFormat {
  return (globalThis.navigator as (Navigator & { gpu?: GPU }) | undefined)?.gpu?.getPreferredCanvasFormat?.() ?? "bgra8unorm";
}

function canvasTextureUsage(): GPUTextureUsageFlags | undefined {
  const usage = (globalThis as { GPUTextureUsage?: typeof GPUTextureUsage }).GPUTextureUsage;
  return usage ? usage.RENDER_ATTACHMENT | usage.TEXTURE_BINDING | usage.COPY_SRC : undefined;
}
