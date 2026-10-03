import { Texture, createResourceIdentity, DestroySignal, type Device, type ResourceDestroyCallback, type ResourceIdentity, type UnsubscribeResourceDestroy } from "@vgpu/core";
import { BUILT_IN_CLEAR_COLOR, colorAttachment, copyClearColor, depthAttachment, sameSize, validateClearColor, type ClearColor } from "./target-utils.ts";
import type { RenderPassDescriptorOptions, Target, TargetSignature } from "./target.ts";
import {
  surfaceAutoResizeUnsupportedError,
  surfaceContextError,
  surfaceDisposedError,
  surfaceDepthInvalidError,
  surfaceDuplicateError,
  surfaceMsaaInvalidError,
  surfaceResizeReentrantError,
} from "./errors.ts";
import { frameState } from "./frame-state.ts";
import { SURFACE_TARGET, TARGET_SIGNATURE } from "./draw-protocols.ts";
import { liveKernel } from "./live-kernel.ts";
import { serviceToken, type Gpu, type Kernel } from "./kernel.ts";

export interface SurfaceOptions {
  readonly autoResize?: boolean;
  /**
   * Default clear color of this surface, used by passes that clear without naming a color.
   * Defaults to `[0, 0, 0, 1]`; mutable at runtime through `surface.clearColor`.
   */
  readonly clearColor?: ClearColor;
  readonly dpr?: number | readonly [number, number];
  readonly size?: readonly [number, number];
  readonly format?: GPUTextureFormat;
  readonly alphaMode?: GPUCanvasAlphaMode;
  readonly colorSpace?: PredefinedColorSpace;
  readonly depth?: boolean | GPUTextureFormat;
  readonly msaa?: boolean | 4;
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

/**
 * Canvas render target of this gpu: configures the canvas context and keeps it sized.
 *
 * One live surface per canvas — a second `surface(gpu, canvas)` on the same canvas throws
 * `VGPU-SURFACE-DUPLICATE`, because reconfiguring a context out from under a live surface silently
 * invalidates its textures. Disposing the surface frees the canvas for a new one.
 *
 * Lifecycle: the surface resizes itself right after the frame clock advances (auto-resize is a
 * frame-state hook, so no rAF of its own), and it goes down with the gpu in the `resource` phase —
 * after the loops stopped, before the caches and the device.
 */
export function surface(gpu: Gpu, canvas: SurfaceCanvas, opts: SurfaceOptions = {}): Surface {
  const kernel = liveKernel(gpu, "surface");
  const open = openSurfaces(kernel);
  const existing = open.get(canvas);
  if (existing && !existing.disposed) throw surfaceDuplicateError(existing.label);
  const created = new CanvasSurface(kernel.device, canvas, opts, (disposed) => {
    if (open.get(disposed.canvas) === disposed) open.delete(disposed.canvas);
    releaseAutoResize();
    releaseOwnership();
  });
  const releaseAutoResize = frameState(kernel).onAdvance(() => created.applyAutoResize());
  const releaseOwnership = kernel.own("resource", () => created.dispose());
  open.set(canvas, created);
  return created;
}

/** Live surfaces of a gpu, keyed by canvas: the duplicate-configure guard, created on first surface. */
const openSurfacesToken = serviceToken<Map<SurfaceCanvas, CanvasSurface>>("surfaces");
function openSurfaces(kernel: Kernel): Map<SurfaceCanvas, CanvasSurface> {
  return kernel.service(openSurfacesToken, () => new Map<SurfaceCanvas, CanvasSurface>());
}

let resizeCallbackDepth = 0;
let frameDepth = 0;
export function isSurfaceResizeCallbackActive(): boolean { return resizeCallbackDepth > 0; }
export function isFrameActive(): boolean { return frameDepth > 0; }
export function enterFrame(): void { frameDepth += 1; }
export function leaveFrame(): void { frameDepth -= 1; }
export function isSurface(target: unknown): target is CanvasSurface { return target instanceof CanvasSurface; }

interface SurfaceAttachments {
  readonly msaaColor?: Texture;
  readonly depth?: Texture;
  readonly all: readonly Texture[];
}

export class CanvasSurface implements Surface {
  readonly [SURFACE_TARGET] = true;
  readonly resourceIdentity = createResourceIdentity("render-target");
  readonly label: string | undefined;
  readonly context: GPUCanvasContext;
  readonly autoResize: boolean;
  readonly layoutBacked: boolean;
  readonly format: GPUTextureFormat;
  readonly #signature: TargetSignature;
  readonly #depthFormat: GPUTextureFormat | undefined;
  readonly #sampleCount: 1 | 4;
  readonly #destroySignal = new DestroySignal<Target>();
  readonly #callbacks = new Set<(event: SurfaceResizeEvent) => void>();
  readonly #texturesRecreatedCallbacks = new Set<() => void>();
  #currentDpr: number;
  #clearColor: ClearColor;
  #attachments!: SurfaceAttachments;
  #generationSize!: readonly [number, number];
  #isDisposed = false;
  #notifying = false;

  constructor(
    private readonly device: Device,
    readonly canvas: SurfaceCanvas,
    private readonly options: SurfaceOptions,
    private readonly unregister: (surface: CanvasSurface) => void,
  ) {
    this.label = options.label;
    this.#clearColor = options.clearColor === undefined ? BUILT_IN_CLEAR_COLOR : validateClearColor(options.clearColor, "surface.clearColor");
    const context = canvas.getContext("webgpu") as GPUCanvasContext | null;
    if (!context) throw surfaceContextError();
    this.context = context;
    this.layoutBacked = isLayoutBacked(canvas);
    if (options.autoResize === true && !this.layoutBacked) throw surfaceAutoResizeUnsupportedError();
    this.autoResize = options.autoResize ?? (options.size ? false : this.layoutBacked);
    this.#currentDpr = effectiveDpr(options.dpr);
    this.format = options.format ?? preferredCanvasFormat();
    this.#depthFormat = surfaceDepthFormat(options.depth);
    this.#sampleCount = surfaceSampleCount(options.msaa);
    this.#signature = Object.freeze({ colors: Object.freeze([this.format]), depth: this.#depthFormat, sampleCount: this.#sampleCount });
    const previousSize = canvasSize(canvas);
    const initialSize = initialCanvasSize(canvas, options, this.layoutBacked, this.#currentDpr);
    if (options.size || this.layoutBacked) setCanvasSize(canvas, initialSize);
    try {
      context.configure({
        device: device.gpu,
        format: this.format,
        alphaMode: options.alphaMode ?? "premultiplied",
        colorSpace: options.colorSpace ?? "srgb",
        usage: canvasTextureUsage(),
      });
      this.#attachments = this.#allocateAttachments(initialSize);
      this.#generationSize = Object.freeze([...initialSize]) as readonly [number, number];
    } catch (error) {
      try { context.unconfigure?.(); } catch { /* Preserve the construction error. */ }
      if (options.size || this.layoutBacked) {
        try { setCanvasSize(canvas, previousSize); } catch { /* Preserve the construction error. */ }
      }
      throw error;
    }
  }

  get gpu(): unknown { return this.context; }
  get size(): readonly [number, number] { this.#assertLive(); return canvasSize(this.canvas); }
  get texelSize(): readonly [number, number] { const size = this.size; return [1 / size[0], 1 / size[1]]; }
  get color(): Texture {
    this.#assertLive();
    return new Texture(this.device, this.context.getCurrentTexture(), {
      kind: "2d",
      size: this.size,
      format: this.format,
      usage: ["render_attachment", "texture_binding", "copy_src"],
      label: this.options.label ? `${this.options.label}.color` : "surface.color",
    }, "external");
  }
  get colors(): readonly [Texture, ...Texture[]] { return [this.color]; }
  get depth(): Texture | undefined { this.#assertLive(); return this.#attachments.depth; }
  get sampleCount(): 1 | 4 { this.#assertLive(); return this.#sampleCount; }
  get dpr(): number { return this.#currentDpr; }
  /** Default clear color of this surface; passes that clear without naming a color use it. */
  get clearColor(): ClearColor { return copyClearColor(this.#clearColor); }
  set clearColor(value: ClearColor) { this.#clearColor = validateClearColor(value, "surface.clearColor"); }
  get disposed(): boolean { return this.#isDisposed; }

  [TARGET_SIGNATURE](): TargetSignature {
    this.#assertLive();
    return this.#signature;
  }

  resize(size: readonly [number, number]): void {
    this.#assertLive();
    if (this.#notifying) throw surfaceResizeReentrantError(this.options.label);
    this.#applyResize(sanitizeSize(size), this.#currentDpr, true);
  }

  applyAutoResize(): void {
    if (this.#isDisposed) return;
    if (this.autoResize && this.layoutBacked) {
      const nextDpr = effectiveDpr(this.options.dpr);
      const nextSize = layoutCanvasSize(this.canvas, nextDpr);
      this.#applyResize(nextSize, nextDpr, true);
      return;
    }
    const currentCanvasSize = sanitizeSize(canvasSize(this.canvas));
    if (!sameSize(this.#generationSize, currentCanvasSize)) {
      this.#applyResize(currentCanvasSize, this.#currentDpr, false);
    }
  }

  onResize(cb: (event: SurfaceResizeEvent) => void): () => void {
    this.#assertLive();
    this.#callbacks.add(cb);
    const wasNotifying = this.#notifying;
    this.#notifying = true;
    resizeCallbackDepth += 1;
    try { cb(this.#event()); }
    finally { resizeCallbackDepth -= 1; this.#notifying = wasNotifying; }
    return () => { this.#callbacks.delete(cb); };
  }

  onDestroy(cb: ResourceDestroyCallback<Target>): UnsubscribeResourceDestroy { this.#assertLive(); return this.#destroySignal.onDestroy(this, cb); }
  onTexturesRecreated(cb: () => void): () => void { this.#assertLive(); this.#texturesRecreatedCallbacks.add(cb); return () => { this.#texturesRecreatedCallbacks.delete(cb); }; }

  renderPassDescriptor(opts: RenderPassDescriptorOptions = {}): GPURenderPassDescriptor {
    const { clear = [0, 0, 0, 1], preserve, clearDepth, clearStencil, depthReadOnly } = opts;
    this.#assertLive();
    const currentCanvasSize = sanitizeSize(canvasSize(this.canvas));
    if (!sameSize(this.#generationSize, currentCanvasSize)) {
      this.#applyResize(currentCanvasSize, this.#currentDpr, false);
    }
    const resolved = this.context.getCurrentTexture();
    return {
      colorAttachments: [colorAttachment(resolved, this.#attachments.msaaColor, clear, preserve)],
      depthStencilAttachment: this.#attachments.depth
        ? depthAttachment(this.#attachments.depth, preserve, clearDepth, clearStencil, depthReadOnly)
        : undefined,
    };
  }

  dispose(): void {
    if (this.#isDisposed) return;
    this.#isDisposed = true;
    try { this.context.unconfigure?.(); } catch { /* ignore native cleanup failures */ }
    const errors: unknown[] = [];
    try { this.unregister(this); } catch (error) { errors.push(error); }
    this.#callbacks.clear();
    this.#texturesRecreatedCallbacks.clear();
    try { this.#destroySignal.emit(this); } catch (error) { errors.push(error); }
    try { destroyTextures(this.#attachments.all); } catch (error) { errors.push(error); }
    if (errors.length) throw errors[0];
  }

  #applyResize(size: readonly [number, number], dpr: number, notify: boolean): void {
    const generationChanged = !sameSize(this.#generationSize, size);
    const canvasChanged = !sameSize(canvasSize(this.canvas), size);
    if (!generationChanged && !canvasChanged) {
      this.#currentDpr = dpr;
      return;
    }
    const nextSize = Object.freeze([...size]) as readonly [number, number];
    const next = generationChanged ? this.#allocateAttachments(nextSize) : this.#attachments;
    const previous = this.#attachments;
    const notifyPublic = notify && (canvasChanged || (generationChanged && previous.all.length > 0));
    const wasNotifying = this.#notifying;
    this.#notifying = true;
    resizeCallbackDepth += 1;
    try {
      if (canvasChanged) setCanvasSize(this.canvas, nextSize);
      this.#currentDpr = dpr;
      this.#generationSize = nextSize;
      this.#attachments = next;
      const errors: unknown[] = [];
      try { this.#emitTexturesRecreated(); } catch (error) { errors.push(error); }
      if (notifyPublic) {
        try { this.#notify(); } catch (error) { errors.push(error); }
      }
      if (generationChanged) {
        try { destroyTextures(previous.all); } catch (error) { errors.push(error); }
      }
      if (errors.length) throw errors[0];
    } finally {
      resizeCallbackDepth -= 1;
      this.#notifying = wasNotifying;
    }
  }

  #emitTexturesRecreated(): void {
    const errors: unknown[] = [];
    for (const cb of [...this.#texturesRecreatedCallbacks]) {
      try { cb(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw errors[0];
  }

  #notify(): void {
    const event = this.#event();
    const errors: unknown[] = [];
    for (const cb of [...this.#callbacks]) {
      try { cb(event); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw errors[0];
  }

  #event(): SurfaceResizeEvent {
    const size = canvasSize(this.canvas);
    return { width: size[0], height: size[1], dpr: this.#currentDpr, surface: this };
  }

  #assertLive(): void {
    if (this.#isDisposed) throw surfaceDisposedError(this.options.label);
  }

  #allocateAttachments(size: readonly [number, number]): SurfaceAttachments {
    const allocated: Texture[] = [];
    const create = (options: Parameters<Device["createTexture"]>[0]): Texture => {
      const texture = this.device.createTexture(options);
      allocated.push(texture);
      return texture;
    };
    try {
      const msaaColor = this.#sampleCount === 4 ? create({
        kind: "2d",
        size,
        format: this.format,
        usage: ["render_attachment"],
        sampleCount: 4,
        label: this.options.label ? `${this.options.label}.color.msaa` : "surface.color.msaa",
      }) : undefined;
      const depth = this.#depthFormat ? create({
        kind: "2d",
        size,
        format: this.#depthFormat,
        usage: ["render_attachment", "texture_binding"],
        sampleCount: this.#sampleCount,
        label: this.options.label ? `${this.options.label}.depth` : "surface.depth",
      }) : undefined;
      return { msaaColor, depth, all: allocated };
    } catch (error) {
      try { destroyTextures(allocated); } catch { /* Preserve the allocation error. */ }
      throw error;
    }
  }
}

const SURFACE_DEPTH_FORMATS = new Set<GPUTextureFormat>([
  "depth16unorm",
  "depth24plus",
  "depth24plus-stencil8",
  "depth32float",
  "depth32float-stencil8",
]);

function surfaceDepthFormat(value: SurfaceOptions["depth"]): GPUTextureFormat | undefined {
  if (value === undefined || value === false) return undefined;
  if (value === true) return "depth24plus";
  if (SURFACE_DEPTH_FORMATS.has(value)) return value;
  throw surfaceDepthInvalidError(value);
}

function surfaceSampleCount(value: SurfaceOptions["msaa"]): 1 | 4 {
  if (value === undefined || value === false) return 1;
  if (value === true || value === 4) return 4;
  throw surfaceMsaaInvalidError(value);
}

function destroyTextures(textures: readonly Texture[]): void {
  const errors: unknown[] = [];
  for (const texture of textures) {
    try { texture.destroy(); } catch (error) { errors.push(error); }
  }
  if (errors.length) throw errors[0];
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
