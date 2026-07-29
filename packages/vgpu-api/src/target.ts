import type { ClearColor } from "./target-utils.ts";
import type { Texture, ResourceDestroyCallback, ResourceIdentity, UnsubscribeResourceDestroy } from "@vgpu/core";

export interface TargetTextureOptions {
  readonly format?: GPUTextureFormat;
  /**
   * Default clear color of this target, used by passes that clear without naming a color.
   * Defaults to `[0, 0, 0, 1]`; mutable at runtime through `target.clearColor`.
   */
  readonly clearColor?: ClearColor;
  readonly colors?: readonly { readonly format: GPUTextureFormat }[];
  readonly depth?: boolean | GPUTextureFormat;
  readonly msaa?: boolean | 4;
  readonly label?: string;
}

export interface TargetOptions extends TargetTextureOptions {
  readonly size: readonly [number, number];
}

export interface TargetSignature {
  readonly colors: readonly GPUTextureFormat[];
  readonly depth?: GPUTextureFormat;
  readonly sampleCount?: 1 | 4;
}

export type CompileTarget = Target | TargetSignature;

/** Options bag for `Target.renderPassDescriptor()`. `Frame.pass` supplies these from `FramePassOptions`. */
export interface RenderPassDescriptorOptions {
  /** Clear color for all color attachments unless `preserve` is true. Defaults to `[0, 0, 0, 1]`. */
  readonly clear?: ClearColor;
  /** When true, color and depth attachments load existing contents and omit clear values. */
  readonly preserve?: boolean;
  /** Depth clear value used when the pass clears. Defaults to `1`. */
  readonly clearDepth?: number;
  /** Stencil clear value used when the pass clears. Defaults to `0`. */
  readonly clearStencil?: number;
  /** Builds the depth-stencil attachment read-only, omitting its load/store ops (stencil aspect included). */
  readonly depthReadOnly?: boolean;
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
  /**
   * Default clear color of this target: the color a pass uses when it clears without naming one
   * (`pass(target, body)` or `clear: true`). Writable at runtime, validated on assignment.
   * Precedence: pass `clear` color > `target.clearColor` > the built-in `[0, 0, 0, 1]`.
   */
  clearColor: ClearColor;
  readonly resourceIdentity: ResourceIdentity;
  resize(size: readonly [number, number]): void;
  /** Raw unpadded bytes of `color` in the target's own format (`bgra*` swizzled to RGBA). */
  read(): Promise<Uint8Array>;
  /** Components of `color` decoded to f32 — the HDR-friendly readback for `rgba16float`/`rgba32float` targets. */
  readFloats(): Promise<Float32Array>;
  onDestroy(cb: ResourceDestroyCallback<Target>): UnsubscribeResourceDestroy;
  renderPassDescriptor(opts?: RenderPassDescriptorOptions): GPURenderPassDescriptor;
}

export { OffscreenTarget } from "./target-offscreen.ts";
export type { Surface, SurfaceOptions, SurfaceResizeEvent } from "./surface.ts";
