import { Texture, createResourceIdentity, DestroySignal, type Device, type ResourceDestroyCallback, type ResourceIdentity, type UnsubscribeResourceDestroy } from "@vgpu/core";
import type { RenderPassDescriptorOptions, Target, TargetOptions, TargetTextureOptions } from "./target.ts";
import { BUILT_IN_CLEAR_COLOR, colorAttachment, copyClearColor, colorSpecsFor, depthAttachment, depthFormatFor, sampleCountFor, sameSize, validateClearColor, validateTargetOptions, type ClearColor } from "./target-utils.ts";
import { liveKernel } from "./live-kernel.ts";
import type { Gpu } from "./kernel.ts";
import { VGPUError } from "./errors.ts";
import { assertDeviceUsable } from "./lifecycle.ts";

interface Attachments {
  readonly colors: readonly [Texture, ...Texture[]];
  readonly msaaColors?: readonly [Texture, ...Texture[]];
  readonly depth?: Texture;
  readonly all: readonly Texture[];
}

function destroyTextures(textures: readonly Texture[]): void {
  const errors: unknown[] = [];
  for (const texture of textures) {
    try { texture.destroy(); } catch (error) { errors.push(error); }
  }
  if (errors.length) throw errors[0];
}

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
  #attachments: Attachments;
  #clearColor: ClearColor;
  #destroyed = false;
  #replacing = false;
  private readonly options: TargetOptions;

  constructor(private readonly device: Device, options: TargetOptions) {
    validateTargetOptions(options, device);
    this.options = Object.freeze({ ...options, size: Object.freeze([...options.size]) as readonly [number, number],
      ...(options.colors ? { colors: Object.freeze(options.colors.map((color) => Object.freeze({ ...color }))) } : {}),
    });
    this.#clearColor = options.clearColor === undefined ? BUILT_IN_CLEAR_COLOR : validateClearColor(options.clearColor, "target.clearColor");
    this.#currentSize = this.options.size;
    this.#attachments = this.#allocateTextures(this.#currentSize);
  }

  get gpu(): unknown { return this.color.gpu; }
  get size(): readonly [number, number] { return this.#currentSize; }
  get texelSize(): readonly [number, number] { return [1 / this.#currentSize[0], 1 / this.#currentSize[1]]; }
  /** Resolved, sampleable color texture. For MSAA targets, render passes resolve into this texture. */
  get color(): Texture { return this.#attachments.colors[0]; }
  /** Resolved, sampleable color textures. For MSAA targets, render passes resolve into these textures. */
  get colors(): readonly [Texture, ...Texture[]] { return this.#attachments.colors; }
  get depth(): Texture | undefined { return this.#attachments.depth; }
  get format(): GPUTextureFormat { return colorSpecsFor(this.options)[0]?.format ?? "rgba8unorm"; }
  /** Default clear color of this target; passes that clear without naming a color use it. */
  get clearColor(): ClearColor { return copyClearColor(this.#clearColor); }
  set clearColor(value: ClearColor) { this.#clearColor = validateClearColor(value, "target.clearColor"); }
  get sampleCount(): 1 | 4 { return sampleCountFor(this.options); }

  resize(size: readonly [number, number]): void {
    this.#assertAlive("Target.resize");
    if (this.#replacing) throw new VGPUError({ code: "VGPU-TARGET-RESIZE-REENTRANT", message: "Cannot resize a target from its replacement callbacks.", where: "Target.resize" });
    validateTargetOptions({ ...this.options, size }, this.device);
    if (sameSize(this.#currentSize, size)) return;
    this.#replacing = true;
    try {
      // Prepare everything before publishing anything. Only synchronous preparation can roll back;
      // late GPU errors still go through the device's existing error reporting.
      const nextSize = Object.freeze([...size]) as readonly [number, number];
      const next = this.#allocateTextures(nextSize);
      const previous = this.#attachments;
      this.#currentSize = nextSize;
      this.#attachments = next;
      // Target bindings follow the new generation before old attachment destruction signals fire.
      try { this.#emitTexturesRecreated(); }
      finally { destroyTextures(previous.all); }
    } finally { this.#replacing = false; }
  }

  onDestroy(cb: ResourceDestroyCallback<Target>): UnsubscribeResourceDestroy { return this.#destroySignal.onDestroy(this, cb); }
  onTexturesRecreated(cb: () => void): () => void { this.#assertAlive("Target.onTexturesRecreated"); this.#texturesRecreatedCallbacks.add(cb); return () => { this.#texturesRecreatedCallbacks.delete(cb); }; }
  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    try { this.#destroySignal.emit(this); }
    finally { this.#texturesRecreatedCallbacks.clear(); destroyTextures(this.#attachments.all); }
  }

  renderPassDescriptor(opts: RenderPassDescriptorOptions = {}): GPURenderPassDescriptor {
    this.#assertAlive("Target.renderPassDescriptor");
    const { clear = [0, 0, 0, 1], preserve, clearDepth, clearStencil, depthReadOnly } = opts;
    return {
      colorAttachments: this.colors.map((resolved, index) => colorAttachment(resolved, this.#attachments.msaaColors?.[index], clear, preserve)),
      depthStencilAttachment: this.depth ? depthAttachment(this.depth, preserve, clearDepth, clearStencil, depthReadOnly) : undefined,
    };
  }

  #assertAlive(where: string): void {
    if (this.#destroyed) throw new VGPUError({ code: "VGPU-TARGET-DESTROYED", message: `Target '${this.options.label ?? "target"}' is destroyed.`, where, fix: "Create a new target; destroyed targets cannot be resized or rendered." });
    assertDeviceUsable(this.device, where);
  }

  #emitTexturesRecreated(): void {
    const errors: unknown[] = [];
    for (const cb of [...this.#texturesRecreatedCallbacks]) {
      try { cb(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw errors[0];
  }

  #allocateTextures(size: readonly [number, number]): Attachments {
    const allocated: Texture[] = [];
    const create = (opts: Parameters<Device["createTexture"]>[0]): Texture => {
      const texture = this.device.createTexture(opts);
      allocated.push(texture);
      return texture;
    };
    try {
      const colors = this.#createResolvedColors(size, create);
      const msaaColors = this.sampleCount === 4 ? this.#createMsaaColors(size, create) : undefined;
      const depth = this.#createDepth(size, create);
      return { colors: Object.freeze(colors), msaaColors: msaaColors && Object.freeze(msaaColors), depth, all: allocated };
    } catch (error) {
      try { destroyTextures(allocated); } catch { /* Preserve the preparation error. */ }
      throw error;
    }
  }

  #createResolvedColors(size: readonly [number, number], create: Device["createTexture"]): [Texture, ...Texture[]] {
    return colorSpecsFor(this.options).map((spec, index) => create({
      kind: "2d",
      size,
      format: spec.format,
      usage: ["render_attachment", "texture_binding", "copy_src"],
      sampleCount: 1,
      label: this.options.label ? `${this.options.label}.color${index}.resolve` : undefined,
    })) as [Texture, ...Texture[]];
  }

  #createMsaaColors(size: readonly [number, number], create: Device["createTexture"]): [Texture, ...Texture[]] {
    return colorSpecsFor(this.options).map((spec, index) => create({
      kind: "2d",
      size,
      format: spec.format,
      usage: ["render_attachment"],
      sampleCount: 4,
      label: this.options.label ? `${this.options.label}.color${index}` : undefined,
    })) as [Texture, ...Texture[]];
  }

  #createDepth(size: readonly [number, number], create: Device["createTexture"]): Texture | undefined {
    const format = depthFormatFor(this.options);
    // texture_binding lets read-only depth passes bind `target.depth` as a sampled texture in the same pass.
    return format ? create({
      kind: "2d",
      size,
      format,
      // texture_binding lets later passes read the depth (fog, occlusion, SSAO) without a copy.
      usage: ["render_attachment", "texture_binding"],
      sampleCount: this.sampleCount,
      label: this.options.label ? `${this.options.label}.depth` : undefined,
    }) : undefined;
  }
}
