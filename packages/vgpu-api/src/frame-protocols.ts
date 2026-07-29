/**
 * Nominal protocols a `Frame` talks to, so `frame.ts` never imports a feature module.
 *
 * `frame(gpu, cb)` must not drag draw, effect, bundle, timer or visibility into a program that
 * does not use them: a frame that only clears a surface pays for a command encoder, nothing else.
 * Concrete classes therefore expose a symbol-keyed protocol object, and the frame resolves it
 * through the `*Of()` accessors below.
 *
 * Rules for this file:
 * - **Nominal, not duck typing.** The symbols are module-private to the package (never exported
 *   from an entrypoint), so only code that imported this module can implement a protocol. A plain
 *   object literal from user code can never be mistaken for a drawable or a telemetry owner.
 * - **No registration by side effect.** Nothing self-registers at import time; the object carries
 *   its own protocol, so tree shaking still sees an unused feature as unused.
 * - **Types only.** This module has no runtime dependency of its own (the symbols aside), so
 *   importing it from a feature costs nothing.
 */
import type { Device } from "@vgpu/core";
import type { ClaimedGroupValidationResult } from "./claim-validation.ts";
import type { DrawCallOptions } from "./draw.ts";
import type { Target } from "./target.ts";

/**
 * Identity of the frame a protocol call belongs to. Owners key their per-frame bookkeeping on it
 * and never inspect it, so the concrete `Frame` class stays private to `frame.ts`.
 */
export type FrameHandle = object;

// ---------------------------------------------------------------------------
// Drawable: what `FramePass.draw()` encodes (draw.ts, effect.ts, later scene views).
// ---------------------------------------------------------------------------

export const FRAME_DRAWABLE: unique symbol = Symbol("vgpu.frame.drawable");

export interface FrameDrawableProtocol {
  /** Used by pass-level error messages (read-only depth rejections name the offending draw). */
  readonly label: string;
  encode(pass: GPURenderPassEncoder, target: Target, opts: DrawCallOptions, claimValidation?: (result: ClaimedGroupValidationResult) => void): void;
  /** True when the drawable's depth state writes depth — rejected by a `depthReadOnly` pass. */
  writesDepth(): boolean;
  /** Names of the stencil ops that can write, empty when none — rejected by a `depthReadOnly` pass on a stencil format. */
  stencilWritingOps(): readonly string[];
}

export interface FrameDrawable {
  readonly [FRAME_DRAWABLE]: FrameDrawableProtocol;
}

export function frameDrawableOf(value: unknown): FrameDrawableProtocol | undefined {
  return (value as Partial<FrameDrawable> | null | undefined)?.[FRAME_DRAWABLE];
}

// ---------------------------------------------------------------------------
// Bundle: what `FramePass.bundles()` replays (bundle.ts).
// ---------------------------------------------------------------------------

export const FRAME_BUNDLE: unique symbol = Symbol("vgpu.frame.bundle");

export interface FrameBundleProtocol {
  readonly gpu: GPURenderBundle;
  /** Throws `VGPU-R3-BUNDLE-STALE` when the recorded signature no longer matches `target`. */
  assertReplayable(target: Target): void;
}

export interface FrameBundleLike {
  readonly [FRAME_BUNDLE]: FrameBundleProtocol;
}

export function frameBundleOf(value: unknown): FrameBundleProtocol | undefined {
  return (value as Partial<FrameBundleLike> | null | undefined)?.[FRAME_BUNDLE];
}

// ---------------------------------------------------------------------------
// Telemetry: pass attachments (timer.ts, visibility.ts) and their frame owners.
// ---------------------------------------------------------------------------

/**
 * Per-frame lifecycle of anything a pass attached: query rings today, scene view generations later.
 *
 * Exactly one of `frameSubmitted` / `frameAbandoned` runs per frame the owner was attached to.
 * The frame calls `finalizeFrame` only on owners that survived every pass, right before
 * `encoder.finish()`, and `frameAbandoned` on the rest (failed pass, failed finish/submit, cancel)
 * so the retain each owner took at attach time is always released exactly once.
 */
export interface FrameOwner {
  /** Encodes the owner's end-of-frame work (resolve + staging copy) into the frame's still-open encoder. */
  finalizeFrame(frame: FrameHandle, encoder: GPUCommandEncoder): void;
  /** The frame reached the queue: start the readback of what this frame encoded. */
  frameSubmitted(frame: FrameHandle): void;
  /** The frame never reached the queue: drop this frame's pending state and release the retain. */
  frameAbandoned(frame: FrameHandle): void;
}

export const FRAME_PASS_ATTACHMENT: unique symbol = Symbol("vgpu.frame.passAttachment");

export interface FramePassAttachContext {
  /** Identity of the frame being encoded. */
  readonly frame: FrameHandle;
  /** The device the frame encodes against; attachments validate their own device against it. */
  readonly device: Device;
  /** The pass's resolved target, for attachments that require specific attachments (occlusion needs depth). */
  readonly target: Target;
}

/** Occlusion query source of a pass: supplied by the attachment, consumed by `FramePass.occlusion()`. */
export interface FrameOcclusionSource {
  readonly querySet: GPUQuerySet;
  /**
   * Reserves the query index for `query` in this frame. Throws on an unknown/disposed handle.
   * `frame` is optional because a pass can be encoded outside a frame (tests drive `FramePass`
   * directly); the attachment then has no frame to bill the slot to.
   */
  beginQuery(query: object, frame?: FrameHandle): number;
}

/**
 * What attaching contributed to the pass. `owner` is bookkeeping-only; the optional members
 * decorate the render pass descriptor the frame is about to open.
 */
export interface FramePassAttachResult {
  readonly owner: FrameOwner;
  readonly timestampWrites?: GPURenderPassTimestampWrites;
  readonly occlusion?: FrameOcclusionSource;
}

/**
 * Implemented by the value a user hands to a `FramePassOptions` telemetry slot: `timer.span(name)`
 * for `timer`, the instance itself for `visibility`.
 *
 * `attach` may throw (invalid handle, duplicate span, missing depth attachment): the frame treats a
 * throw as a failed pass and rolls the owner's frame bookkeeping back, including any earlier pass
 * of the same frame that the same owner contributed.
 */
export interface FramePassAttachment {
  [FRAME_PASS_ATTACHMENT](ctx: FramePassAttachContext): FramePassAttachResult;
}

export function framePassAttachmentOf(value: unknown): FramePassAttachment | undefined {
  const attach = (value as Partial<FramePassAttachment> | null | undefined)?.[FRAME_PASS_ATTACHMENT];
  return typeof attach === "function" ? (value as FramePassAttachment) : undefined;
}
