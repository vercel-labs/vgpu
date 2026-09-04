import type { Device } from "@vgpu/core";
import { claimedGroupValidationDone, discardClaimedGroupValidationResults, discardClaimedGroupValidationScopes, popLastClaimedGroupValidationScope, preferClaimedGroupValidationResult, pushClaimedGroupValidationScope, submittedWorkDone, type ClaimedGroupValidationResult, type ValidationErrorSink } from "./claim-validation.ts";
import { endRenderPassWithClaimValidation } from "./claim-validation-encode.ts";
import type { Bundle } from "./bundle.ts";
import type { Draw, DrawCallOptions } from "./draw.ts";
import type { Effect } from "./effect.ts";
import type { Target } from "./target.ts";
import { assertDeviceUsable } from "./lifecycle.ts";
import { claimedGroupNativeValidationError, frameAlreadySubmittedError, frameCanceledError, framePassActiveError, frameReentrantError, passClearDepthInvalidError, passClearStencilInvalidError, passDepthReadOnlyError, passDepthReadOnlyMsaaError, passPreserveClearDepthError, passPreserveClearStencilError, passPreserveMsaaError, passScissorInvalidError, passViewportInvalidError, queryNestedError, queryNoVisibilityError, surfaceNotInFrameError, targetRequiredError, timerInvalidError, VGPUError, visibilityInvalidError } from "./errors.ts";
import { enterFrame, isSurface, isSurfaceResizeCallbackActive, leaveFrame } from "./surface.ts";
import { BUILT_IN_CLEAR_COLOR, hasStencilAspect, isTarget, type ClearColor } from "./target-utils.ts";
import type { TimerSpan } from "./timer.ts";
import type { Visibility, VisibilityQuery } from "./visibility.ts";
import { FRAME_PASS_ATTACHMENT, frameBundleOf, frameDrawableOf, framePassAttachmentOf, type FrameDrawableProtocol, type FrameOcclusionSource, type FrameOwner, type FramePassAttachResult } from "./frame-protocols.ts";
import { frameState } from "./frame-state.ts";
import { liveKernel } from "./live-kernel.ts";
import { serviceToken, type Gpu, type Kernel } from "./kernel.ts";

/**
 * Opens a frame on `gpu`: advances the frame clock, runs `cb` against a fresh command encoder and
 * submits it when the callback returns. If the callback throws, the frame is canceled instead —
 * nothing it encoded reaches the queue — and the error is rethrown unchanged; a callback that
 * already submitted or canceled the frame is left as it is. Only the command buffer is covered,
 * not the clock tick or CPU-side state. `frame.submit()` in your own `catch` keeps partial work.
 *
 * Without a callback the frame is yours: encode passes at your own pace and finish it with
 * `frame.submit()` or `frame.cancel()` — an unfinished frame holds every retain its passes took.
 * Frames are not reentrant: opening one from inside another (or from a surface resize callback)
 * throws `VGPU-FRAME-REENTRANT`.
 */
export function frame(gpu: Gpu, cb?: (frame: Frame) => void): Frame {
  return frameRunner(liveKernel(gpu, "frame")).frame(cb);
}

/**
 * Runs `cb` once per animation frame until the returned handle is stopped. Each tick follows the
 * `frame(gpu, cb)` rule: submit on return, cancel on throw. A throwing tick also stops the loop,
 * since its error escapes the animation-frame callback and no further tick would run.
 *
 * The loop belongs to the gpu's `scheduler` phase, so `gpu.dispose()` stops it before anything it
 * could encode against is torn down; a loop that stops on its own drops that registration.
 */
export function frameLoop(gpu: Gpu, cb: FrameLoopCallback, opts: FrameLoopOptions = {}): FrameLoopHandle {
  return frameRunner(liveKernel(gpu, "frameLoop")).loop(cb, opts);
}

/** Assigned by `Frame`'s static block; see the comment there. */
let frameIsOpen!: (frame: Frame) => boolean;

/**
 * One runner per gpu: it carries the reentrancy guard, the frame clock and the loop registrations,
 * so `frame()` and `frameLoop()` share the same state. Created on the first frame, never at `init()`.
 */
const frameRunnerToken = serviceToken<FrameRunner>("frame-runner");
function frameRunner(kernel: Kernel): FrameRunner {
  return kernel.service(frameRunnerToken, (self) => {
    const state = frameState(self);
    return new FrameRunner(
      () => {
        let release = () => {};
        const frame = new Frame(self.device, undefined, (error) => self.reportError(error), (promise) => { void self.trackDelivery(promise); }, () => release());
        release = self.own("scheduler", () => frame.cancel());
        return frame;
      },
      () => state.tick(),
      (handle) => self.own("scheduler", () => handle.stop()),
    );
  });
}

export interface FramePassOptions {
  readonly target: Target;
  /** Omit or pass true to clear with `target.clearColor`; pass false to preserve color/depth; pass a color to clear this pass with it. */
  readonly clear?: boolean | ClearColor;
  /** Depth clear value used when the pass clears. Defaults to 1. Use 0 with depth: { compare: "greater" } for reversed-Z. */
  readonly clearDepth?: number;
  /** Stencil clear value used when the pass clears. Defaults to 0. Requires a depth format with a stencil aspect. */
  readonly clearStencil?: number;
  /** Opens the pass with a read-only depth attachment: depth can be tested against and sampled as a texture in the same pass, but not written. For combined depth-stencil formats the stencil aspect is read-only too. Defaults to false. */
  readonly depthReadOnly?: boolean;
  /** Viewport for every draw in this pass. Defaults to the full target. */
  readonly viewport?: {
    readonly x?: number;
    readonly y?: number;
    readonly width: number;
    readonly height: number;
    readonly minDepth?: number;
    readonly maxDepth?: number;
  };
  /** Scissor rectangle [x, y, width, height] for every draw in this pass. Integers. Note: does not affect the clear — loadOp "clear" always clears the full attachment. */
  readonly scissor?: readonly [number, number, number, number];
  /** Times this pass on the GPU: pass `timer.span(name)` from a `timer(gpu)`. The pass duration lands in `timer.onResults` under `name`, in milliseconds. One span name per frame. */
  readonly timer?: TimerSpan;
  /** Enables occlusion queries in this pass: pass a `visibility(gpu)` instance, then wrap proxy draws in `pass.occlusion(handle, body)`. Requires a target with a depth attachment. */
  readonly visibility?: Visibility;
}

export interface FrameLoopHandle { stop(): void }
export interface FrameLoopOptions { readonly fps?: number }
export type FrameLoopCallback = (frame: Frame) => void;

export class Frame {
  /**
   * Resolves after submitted GPU work completes and raw claimed-bind-group
   * validation has been delivered to `gpu.onError`.
   *
   * This is a completion/timing signal only; it never rejects and is not an error
   * channel.
   */
  done: Promise<void> = Promise.resolve();
  readonly #encoder: GPUCommandEncoder;
  readonly #validations: ClaimedGroupValidationResult[] = [];
  /**
   * Everything a pass of this frame attached, as opaque {@link FrameOwner}s: timers and
   * visibilities today, scene view generations later. The frame never learns what they are — it
   * only guarantees each one sees exactly one `frameSubmitted` or `frameAbandoned`.
   */
  readonly #owners = new Set<FrameOwner>();
  /**
   * Owners whose per-frame bookkeeping a failed pass invalidated: their frame is neither finalized
   * nor read back, so a throwing pass callback cannot leave a phantom result. Kept alongside the
   * live set so a later pass re-attaching the same instance in this frame stays dropped too — the
   * failed pass's span/slots are still in that instance's frame bookkeeping.
   */
  readonly #discardedOwners = new Set<FrameOwner>();
  #submitted = false;
  #canceled = false;
  #passActive = false;
  /**
   * Module-private view of the close state for `FrameRunner`: a callback that already submitted
   * or canceled its frame needs neither the implicit submit nor the cancel-on-throw. Kept out of
   * the public surface — the class exposes no `state` getter — by assigning the module-scoped
   * `frameIsOpen` from inside the class body, where `#private` fields are reachable. The brand
   * check keeps it from throwing on a frame that is not a `Frame` (a test double): an unknown
   * frame is treated as open, and its own cancel() decides.
   */
  static { frameIsOpen = (frame) => !(#submitted in frame) || (!frame.#submitted && !frame.#canceled); }
  constructor(
    private readonly device: Device,
    private readonly defaultTarget?: Target,
    private readonly errorSink?: ValidationErrorSink,
    private readonly trackSettled?: (promise: Promise<unknown>) => void,
    private readonly releaseLifecycle?: () => void,
  ) {
    assertDeviceUsable(device, "Frame.constructor");
    this.#encoder = device.gpu.createCommandEncoder({ label: "vgpu.frame" });
  }

  pass(target: Target, body: Effect | Draw | ((pass: FramePass) => void)): void;
  pass(options: FramePassOptions, body: Effect | Draw | ((pass: FramePass) => void)): void;
  pass(target: Target | FramePassOptions, body: Effect | Draw | ((pass: FramePass) => void)): void {
    // A canceled frame dropped its encoder: encoding into it would silently never run (and would
    // re-take the telemetry retains cancel() just released), so reject the call instead. Checked
    // before the device: `gpu.dispose()` cancels outstanding frames and *then* drops the device, so
    // cancellation is the proximate cause there and names it better than a generic disposed device.
    if (this.#canceled) throw frameCanceledError("Frame.pass");
    assertDeviceUsable(this.device, "Frame.pass");
    const targetOnly = isTarget(target);
    const cb = typeof body === "function" ? body : (p: FramePass) => p.draw(body);
    const resolvedTarget = targetOnly ? target : target.target ?? this.defaultTarget;
    if (!resolvedTarget) throw targetRequiredError("Frame.pass");
    if (isSurface(resolvedTarget) && this.#submitted) throw surfaceNotInFrameError("Frame.pass");
    const clear = targetOnly ? undefined : target.clear;
    const preserve = clear === false;
    if (preserve && resolvedTarget.sampleCount === 4) throw passPreserveMsaaError();
    const clearDepth = targetOnly ? undefined : target.clearDepth;
    if (clearDepth !== undefined) {
      if (typeof clearDepth !== "number" || !(clearDepth >= 0 && clearDepth <= 1)) throw passClearDepthInvalidError(clearDepth);
      if (preserve) throw passPreserveClearDepthError();
      // Dead-option rule, same as clearStencil below: without a depth attachment there is no
      // depthClearValue in the descriptor, so clearDepth would silently do nothing.
      if (!resolvedTarget.depth) {
        throw passClearDepthInvalidError(clearDepth, "but the target has no depth attachment, so clearDepth would have no effect.", "Create the target with depth: true (or a depth format), or drop clearDepth.");
      }
    }
    const clearStencil = targetOnly ? undefined : target.clearStencil;
    if (clearStencil !== undefined) {
      // WebGPU stencilClearValue is GPUStencilValue ([EnforceRange] u32); in-range values are masked to the stencil
      // aspect's bit width by taking the LSBs, so values above 0xFF on stencil8 aspects are legal, not errors.
      if (typeof clearStencil !== "number" || !Number.isInteger(clearStencil) || clearStencil < 0 || clearStencil > 0xFFFFFFFF) {
        throw passClearStencilInvalidError(`received ${String(clearStencil)}; expected an integer in [0, 0xFFFFFFFF] (WebGPU GPUStencilValue).`);
      }
      if (preserve) throw passPreserveClearStencilError();
      const depthFormat = resolvedTarget.depth?.format;
      if (!hasStencilAspect(depthFormat)) throw passClearStencilInvalidError(`received ${String(clearStencil)}, but the target's depth format ${depthFormat ? `"${depthFormat}"` : "(none)"} has no stencil aspect, so clearStencil would have no effect.`);
    }
    const depthReadOnly = targetOnly ? undefined : target.depthReadOnly;
    if (depthReadOnly !== undefined && typeof depthReadOnly !== "boolean") {
      throw passDepthReadOnlyError(`received ${previewValue(depthReadOnly)}; expected a boolean.`, "Pass depthReadOnly: true to open the pass with a read-only depth attachment, or omit it.");
    }
    if (depthReadOnly) {
      // Dead-option and contradiction rules: color attachments still load/clear normally in a read-only
      // pass, so clear (color) stays legal, but the read-only depth/stencil aspects omit their ops entirely
      // and can never be cleared.
      if (!resolvedTarget.depth) throw passDepthReadOnlyError("is set, but the target has no depth attachment, so there is nothing to make read-only.", "Create the target with depth: true (or a depth format), or drop depthReadOnly.");
      // Symmetric to the clear:false MSAA rule: an MSAA target's depth aspect is stored with
      // storeOp "discard" (target-utils depthAttachment), so nothing survives the pass that wrote
      // it. Reading it back read-only would depth-test every draw against discarded contents —
      // silent garbage (with visibility attached, every query reports "hidden").
      if (resolvedTarget.sampleCount === 4) throw passDepthReadOnlyMsaaError();
      if (clearDepth !== undefined) throw passDepthReadOnlyError("cannot be combined with clearDepth; a read-only depth aspect omits its load/store ops and is never cleared.", "Remove clearDepth, or drop depthReadOnly.");
      if (clearStencil !== undefined) throw passDepthReadOnlyError("cannot be combined with clearStencil; a read-only stencil aspect omits its load/store ops and is never cleared.", "Remove clearStencil, or drop depthReadOnly.");
    }
    const viewport = targetOnly ? undefined : validatedViewport(target.viewport, this.device.gpu.limits, resolvedTarget.size);
    const scissor = targetOnly ? undefined : validatedScissor(target.scissor, resolvedTarget.size);
    // Owners this pass attached, in attach order: the rollback set if anything below throws.
    const attached: FrameOwner[] = [];
    let encoder: GPURenderPassEncoder | undefined;
    try {
      // Attaching telemetry mutates per-frame bookkeeping before the native pass opens. Keep the whole
      // attach/setup/body sequence atomic so any later validation/native setup failure rolls it back,
      // not only exceptions thrown by the user callback.
      const timer = targetOnly || target.timer === undefined ? undefined : this.#attach(target.timer, resolvedTarget, attached, timerAttachmentInvalidError);
      const visibility = targetOnly || target.visibility === undefined ? undefined : this.#attach(target.visibility, resolvedTarget, attached, visibilityAttachmentInvalidError);
      const occlusion = visibility?.occlusion;
      // timestampWrites and occlusionQuerySet are target-independent pass state: decorate the descriptor after obtaining it from the target.
      // Clear color precedence: the pass color, then the target's own default, then the built-in.
      let descriptor = resolvedTarget.renderPassDescriptor({ clear: clear === undefined || clear === true || clear === false ? resolvedTarget.clearColor ?? BUILT_IN_CLEAR_COLOR : clear, preserve, clearDepth, clearStencil, depthReadOnly });
      if (timer?.timestampWrites) descriptor = { ...descriptor, timestampWrites: timer.timestampWrites };
      // Mirrors the WebGPU pass descriptor rule: occlusionQuerySet must be a valid query set of type "occlusion".
      if (occlusion) descriptor = { ...descriptor, occlusionQuerySet: occlusion.querySet };
      encoder = this.#encoder.beginRenderPass(descriptor);
      if (viewport) encoder.setViewport(viewport.x, viewport.y, viewport.width, viewport.height, viewport.minDepth, viewport.maxDepth);
      if (scissor) encoder.setScissorRect(scissor[0], scissor[1], scissor[2], scissor[3]);
      this.#passActive = true;
      try {
        cb(new FramePass(encoder, resolvedTarget, this.#validations, depthReadOnly === true, occlusion, this, (where) => {
          // Retained external devices can be destroyed mid-pass, so every FramePass entry point
          // re-checks the device here instead of taking it as a separate constructor argument.
          assertDeviceUsable(this.device, where);
          if (this.#canceled) throw frameCanceledError(where);
        }));
      } finally {
        this.#passActive = false;
      }
    } catch (error) {
      // A failed pass — during setup or in its body — never ran successfully. Leaving telemetry
      // registered makes submit() resolve unwritten queries as phantom results.
      this.#discardOwners(attached);
      discardClaimedGroupValidationResults(this.#validations);
      this.#validations.length = 0;
      discardClaimedGroupValidationScopes(this.device);
      try { encoder?.end(); } catch { /* ignore cleanup failure after encode failure */ }
      throw error;
    }
    endRenderPassWithClaimValidation(this.device, encoder, this.#validations);
  }

  submit(): void {
    // Closed either way: a re-submit has nothing left to flush, and a canceled frame dropped its
    // encoder. Both are silent no-ops so `frame(gpu, cb)`'s implicit submit-on-return never masks
    // a cancel() from inside the callback. Checked before the device so that submitting an
    // already-closed frame stays a no-op even after `gpu.dispose()` took the device with it.
    if (this.#submitted || this.#canceled) return;
    assertDeviceUsable(this.device, "Frame.submit");
    this.#submitted = true;
    this.releaseLifecycle?.();
    // Timed and occlusion-queried frames append one resolveQuerySet of each instance's contiguous
    // used range (plus the staging copy) to the still-open frame encoder — zero extra submissions.
    for (const owner of this.#liveOwners()) owner.finalizeFrame(this, this.#encoder);
    let commandBuffer: GPUCommandBuffer;
    const finishContext = this.#validations[0]?.context;
    if (finishContext) pushClaimedGroupValidationScope(this.device, finishContext);
    try { commandBuffer = this.#encoder.finish(); }
    catch (error) {
      // finish() failed, so the resolves encoded above never reach the queue: nothing may be read
      // back, but every instance still has to release the retain it took when it was attached.
      this.#abandonOwners(this.#frameOwners());
      const result = finishContext ? popLastClaimedGroupValidationScope(this.device) : undefined;
      discardClaimedGroupValidationResults(this.#validations);
      if (result) discardClaimedGroupValidationResults([result]);
      const context = result?.context ?? finishContext;
      if (!context) throw error;
      this.done = this.#trackDone(this.#deliverValidationError(context.label, context.group, error));
      return;
    }
    if (finishContext) {
      const result = popLastClaimedGroupValidationScope(this.device);
      if (result) this.#validations[0] = this.#validations[0] ? preferClaimedGroupValidationResult(result, this.#validations[0]) : result;
    }
    const submitContext = this.#validations[0]?.context;
    if (submitContext) pushClaimedGroupValidationScope(this.device, submitContext);
    try { this.device.gpu.queue.submit([commandBuffer]); }
    catch (error) {
      // Same as the finish() failure: the command buffer never ran, so release the retains and read
      // nothing back — the resolve's staging bytes are stale, not this frame's results.
      this.#abandonOwners(this.#frameOwners());
      const result = submitContext ? popLastClaimedGroupValidationScope(this.device) : undefined;
      discardClaimedGroupValidationResults(this.#validations);
      if (result) discardClaimedGroupValidationResults([result]);
      const context = result?.context ?? submitContext;
      if (!context) throw error;
      this.done = this.#trackDone(this.#deliverValidationError(context.label, context.group, error));
      return;
    }
    if (submitContext) {
      const result = popLastClaimedGroupValidationScope(this.device);
      if (result) this.#validations[0] = this.#validations[0] ? preferClaimedGroupValidationResult(result, this.#validations[0]) : result;
    }
    // The submit succeeded: start each owner's non-blocking readback of this frame's resolve.
    for (const owner of this.#liveOwners()) owner.frameSubmitted(this);
    // Instances a failed pass dropped are skipped above, so they still hold this frame's retain.
    this.#abandonOwners(this.#discardedOwners);
    this.done = this.#trackDone(claimedGroupValidationDone(this.device, this.#validations, { errorSink: this.errorSink }));
  }

  /**
   * Discards the frame without submitting it: the command encoder is dropped (nothing this frame
   * encoded ever runs) and every telemetry instance it attached releases the retain it took on its
   * query ring, so a `timer(gpu)` / `visibility(gpu)` can be disposed for good without waiting for
   * `gpu.dispose()`. This is the explicit way out of the leak a manual `frame(gpu)` would otherwise
   * hold: a frame is never assumed abandoned, because an old frame can still be submitted.
   *
   * Idempotent, like `submit()`: cancelling twice is a no-op, and `submit()` after `cancel()` does
   * nothing. Cancelling a frame that was already submitted throws `VGPU-FRAME-SUBMITTED` — its work
   * is on the queue and cannot be taken back, so silently accepting the call would hide a real
   * lifecycle bug.
   */
  cancel(): void {
    if (this.#canceled) return;
    if (this.#submitted) throw frameAlreadySubmittedError("Frame.cancel");
    // An active pass descriptor still references telemetry query sets. Releasing their retains here
    // could destroy them before encoder.end(), and the callback could keep encoding after cancel.
    if (this.#passActive) throw framePassActiveError("Frame.cancel");
    this.#canceled = true;
    this.releaseLifecycle?.();
    // Nothing is finalized and nothing is read back: the encoded passes never reach the queue, so
    // decoding a resolve would report stale staging bytes as a phantom duration or "hidden".
    this.#abandonOwners(this.#frameOwners());
    this.#owners.clear();
    this.#discardedOwners.clear();
    // The claimed-group validation promises of the dropped encoder are never delivered: no draw of
    // this frame ran, so any native error they carry is about work that was thrown away.
    discardClaimedGroupValidationResults(this.#validations);
    this.#validations.length = 0;
  }

  /**
   * Ends the frame for telemetry instances that will never see a real frameSubmitted: a pass whose
   * callback threw, a frame whose finish/submit failed, or a canceled frame. Each one took a retain
   * on its query ring when it was attached to a pass descriptor (so a mid-frame dispose() cannot
   * destroy a set the frame still points at); without the matching release, a dispose() after the
   * failure leaves the ring alive forever. frameAbandoned() drops the instance's pending encoded
   * state as it releases: a resolve that never reached the queue must not be decoded — its staging
   * buffer holds stale bytes, which would surface as a phantom duration or a phantom "hidden".
   */
  #abandonOwners(owners: Iterable<FrameOwner>): void {
    for (const owner of [...owners]) owner.frameAbandoned(this);
  }

  /** Every owner this frame attached, discarded ones included. */
  #frameOwners(): FrameOwner[] {
    return [...this.#owners, ...this.#discardedOwners];
  }

  /** Moves owners out of this frame's live set: they are neither finalized nor read back. */
  #discardOwners(owners: Iterable<FrameOwner>): void {
    for (const owner of [...owners]) {
      this.#owners.delete(owner);
      this.#discardedOwners.add(owner);
    }
  }

  #liveOwners(): FrameOwner[] {
    return [...this.#owners].filter((owner) => !this.#discardedOwners.has(owner));
  }

  /**
   * Attaches one `FramePassOptions` telemetry value to this pass through the nominal attachment
   * protocol, so the frame never learns whether it is a timer span, a visibility or a future
   * scene-view generation: it only records the owner it must settle exactly once.
   */
  #attach(value: unknown, target: Target, attached: FrameOwner[], invalid: (value: unknown) => VGPUError): FramePassAttachResult {
    const attachment = framePassAttachmentOf(value);
    if (!attachment) throw invalid(value);
    let result: FramePassAttachResult;
    try {
      result = attachment[FRAME_PASS_ATTACHMENT]({ frame: this, device: this.device, target });
    } catch (error) {
      // A duplicate/capacity failure can land after the same instance already contributed an
      // earlier pass to this frame, and a failed attach cannot report whose bookkeeping it left
      // half-written. Drop every owner of the frame rather than let submit() report the earlier
      // pass as a successful partial frame.
      this.#discardOwners(this.#owners);
      throw error;
    }
    this.#owners.add(result.owner);
    attached.push(result.owner);
    return result;
  }

  async #deliverValidationError(label: string, group: number, cause: unknown): Promise<void> {
    await submittedWorkDone(this.device);
    assertDeviceUsable(this.device, "Frame.validation");
    const error = claimedGroupNativeValidationError(label, group, cause);
    if (this.errorSink) await this.errorSink(error);
    else console.error(error);
  }

  #trackDone(promise: Promise<void>): Promise<void> {
    this.trackSettled?.(promise);
    return promise;
  }
}

export class FramePass {
  #occlusionActive = false;
  constructor(private readonly encoder: GPURenderPassEncoder, readonly target: Target, private readonly validations: ClaimedGroupValidationResult[], private readonly depthReadOnly = false, private readonly occlusionSource?: FrameOcclusionSource, private readonly frame?: Frame, private readonly assertFrameOpen?: (where: string) => void) {}
  draw(drawable: Draw | Effect, opts: DrawCallOptions = {}): void {
    this.assertFrameOpen?.("FramePass.draw");
    const encodable = frameDrawable(drawable);
    if (this.depthReadOnly) assertDrawableAllowedInReadOnlyPass(encodable, this.target);
    encodable.encode(this.encoder, this.target, opts, (result) => this.validations.push(result));
  }
  /**
   * Wraps one or more draws in begin/endOcclusionQuery. The body ALWAYS executes; condition your
   * real draws on `q.hidden` outside.
   */
  occlusion(query: VisibilityQuery, body: Draw | Effect | (() => void)): void {
    this.assertFrameOpen?.("FramePass.occlusion");
    if (!this.occlusionSource) throw queryNoVisibilityError();
    // WebGPU beginOcclusionQuery: "no occlusion query must be active for this" — one scope at a time.
    if (this.#occlusionActive) throw queryNestedError();
    const index = this.occlusionSource.beginQuery(query, this.frame);
    this.encoder.beginOcclusionQuery(index);
    this.#occlusionActive = true;
    try {
      if (typeof body === "function") body();
      else this.draw(body);
    } finally {
      // vgpu's scope shape makes an unclosed query structurally impossible: end in finally, so a
      // throwing body can never leave a query open at pass end (which would invalidate the encoder).
      this.#occlusionActive = false;
      this.encoder.endOcclusionQuery();
    }
  }
  bundles(...bundles: readonly Bundle[]): void {
    this.assertFrameOpen?.("FramePass.bundles");
    // WebGPU executeBundles: "If this.[[depthReadOnly]] is true, bundle.[[depthReadOnly]] must be true.
    // If this.[[stencilReadOnly]] is true, bundle.[[stencilReadOnly]] must be true." bundle always
    // records bundles with both flags false, so no recorded bundle can replay into a read-only pass;
    // reject up front instead of leaving it to native validation.
    if (this.depthReadOnly) throw passDepthReadOnlyError("pass cannot replay bundles: bundle records bundles with writable depth/stencil, and WebGPU only executes read-only-recorded bundles in a read-only pass.", "Encode the draws directly with pass.draw(...) inside the depthReadOnly pass.", "FramePass.bundles");
    const recorded = bundles.map((entry) => frameBundleOf(entry) ?? invalidBundle());
    // Staleness is checked for every bundle before the first one replays: a pass either replays the
    // whole list or none of it.
    for (const entry of recorded) entry.assertReplayable(this.target);
    this.encoder.executeBundles(recorded.map((entry) => entry.gpu));
  }
}

/**
 * Early equivalent of the WebGPU setPipeline device-timeline checks: "If pipeline.[[writesDepth]]:
 * this.[[depthReadOnly]] must be false. If pipeline.[[writesStencil]]: this.[[stencilReadOnly]] must be
 * false." A depthReadOnly pass marks the stencil aspect read-only too (combined formats), so both are
 * validated here with actionable errors before encoding.
 */
function assertDrawableAllowedInReadOnlyPass(drawable: FrameDrawableProtocol, target: Target): void {
  if (drawable.writesDepth()) {
    throw passDepthReadOnlyError(`pass cannot encode draw '${drawable.label}': its depth state writes depth (the default is write: true). Give the draw depth: { write: false } (or depth: false to disable depth testing).`, "Use depth: { write: false } on the draw, or open the pass without depthReadOnly.", "FramePass.draw");
  }
  if (hasStencilAspect(target.depth?.format)) {
    const ops = drawable.stencilWritingOps();
    if (ops.length) {
      throw passDepthReadOnlyError(`pass cannot encode draw '${drawable.label}': its stencil ops can write (${ops.join(", ")}), and the pass's stencil aspect is read-only too.`, `Use "keep" for those ops or stencil writeMask: 0, or open the pass without depthReadOnly.`, "FramePass.draw");
    }
  }
}

/** Nominal drawable protocol of a `Draw` or an `Effect`; the frame never imports either module. */
function frameDrawable(drawable: Draw | Effect): FrameDrawableProtocol {
  const encodable = frameDrawableOf(drawable);
  // Historical message kept: "Invalid Effect instance" is what an unrecognized drawable reported
  // when the frame resolved it by shape.
  if (!encodable) throw new TypeError("Invalid Effect instance: pass.draw() expects a Draw or an Effect created by this library.");
  return encodable;
}

function invalidBundle(): never {
  throw new VGPUError({ code: "VGPU-R3-BUNDLE-INVALID", message: "p.bundles() expected bundles created by bundle(gpu, { target }, cb).", where: "FramePass.bundles" });
}

function timerAttachmentInvalidError(value: unknown): VGPUError {
  return timerInvalidError(`FramePassOptions.timer received ${previewValue(value)}; expected a TimerSpan from timer.span(name).`, `Create const passTimer = timer(gpu) once, then pass passTimer.span("name") per pass.`, "Frame.pass");
}

function visibilityAttachmentInvalidError(value: unknown): VGPUError {
  return visibilityInvalidError(`FramePassOptions.visibility received ${previewValue(value)}; expected a Visibility from visibility(gpu).`, "Create const vis = visibility(gpu) once, then pass { target, visibility: vis } per pass.", "Frame.pass");
}

/**
 * Mirrors the WebGPU setViewport device-timeline validation (arguments are floats;
 * bounds check against device limits, not the attachment): with maxViewportRange =
 * maxTextureDimension2D × 2, requires x ≥ -maxViewportRange, y ≥ -maxViewportRange,
 * 0 ≤ width/height ≤ maxTextureDimension2D, x + width ≤ maxViewportRange − 1,
 * y + height ≤ maxViewportRange − 1, 0 ≤ minDepth ≤ 1, 0 ≤ maxDepth ≤ 1, and
 * minDepth ≤ maxDepth.
 */
function validatedViewport(viewport: FramePassOptions["viewport"], limits: GPUSupportedLimits, targetSize: readonly [number, number]): { x: number; y: number; width: number; height: number; minDepth: number; maxDepth: number } | undefined {
  if (viewport === undefined) return undefined;
  if (typeof viewport !== "object" || viewport === null || Array.isArray(viewport)) throw passViewportInvalidError(`received ${previewValue(viewport)}; expected { x?, y?, width, height, minDepth?, maxDepth? }.`);
  const { x = 0, y = 0, width, height, minDepth = 0, maxDepth = 1 } = viewport;
  for (const [name, value] of [["x", x], ["y", y], ["width", width], ["height", height], ["minDepth", minDepth], ["maxDepth", maxDepth]] as const) {
    if (typeof value !== "number" || !Number.isFinite(value)) throw passViewportInvalidError(`${name} received ${previewValue(value)}; expected a finite number.`);
  }
  const max = limits.maxTextureDimension2D;
  const maxViewportRange = max * 2;
  const sizeNote = `target is ${targetSize[0]}x${targetSize[1]}px, device maxTextureDimension2D is ${max}`;
  if (!(width >= 0 && width <= max)) throw passViewportInvalidError(`width ${width} is outside [0, ${max}] (${sizeNote}).`);
  if (!(height >= 0 && height <= max)) throw passViewportInvalidError(`height ${height} is outside [0, ${max}] (${sizeNote}).`);
  if (!(x >= -maxViewportRange && x + width <= maxViewportRange - 1)) throw passViewportInvalidError(`x ${x} with width ${width} is outside [${-maxViewportRange}, ${maxViewportRange - 1}] (${sizeNote}).`);
  if (!(y >= -maxViewportRange && y + height <= maxViewportRange - 1)) throw passViewportInvalidError(`y ${y} with height ${height} is outside [${-maxViewportRange}, ${maxViewportRange - 1}] (${sizeNote}).`);
  if (!(minDepth >= 0 && minDepth <= 1)) throw passViewportInvalidError(`minDepth ${minDepth} is outside [0, 1].`);
  if (!(maxDepth >= 0 && maxDepth <= 1)) throw passViewportInvalidError(`maxDepth ${maxDepth} is outside [0, 1].`);
  if (!(minDepth <= maxDepth)) throw passViewportInvalidError(`minDepth ${minDepth} exceeds maxDepth ${maxDepth}.`);
  return { x, y, width, height, minDepth, maxDepth };
}

/**
 * Mirrors the WebGPU setScissorRect validation: arguments are GPUIntegerCoordinate
 * (non-negative integers), and the rectangle must satisfy x + width ≤ attachment
 * width and y + height ≤ attachment height against the target's current size.
 */
function validatedScissor(scissor: FramePassOptions["scissor"], targetSize: readonly [number, number]): readonly [number, number, number, number] | undefined {
  if (scissor === undefined) return undefined;
  if (!Array.isArray(scissor) || scissor.length !== 4) throw passScissorInvalidError(`received ${previewValue(scissor)}; expected [x, y, width, height].`);
  const [x, y, width, height] = scissor;
  for (const [name, value] of [["x", x], ["y", y], ["width", width], ["height", height]] as const) {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw passScissorInvalidError(`${name} received ${previewValue(value)}; expected a non-negative integer.`);
  }
  const [targetWidth, targetHeight] = targetSize;
  if (x + width > targetWidth || y + height > targetHeight) {
    throw passScissorInvalidError(`[${x}, ${y}, ${width}, ${height}] exceeds the target's current size ${targetWidth}x${targetHeight}px (x + width <= ${targetWidth}, y + height <= ${targetHeight}).`);
  }
  return [x, y, width, height];
}

function previewValue(value: unknown): string {
  if (typeof value === "string") return `'${value}'`;
  if (Array.isArray(value)) return `[${value.map((entry) => previewValue(entry)).join(", ")}]`;
  if (typeof value === "object" && value !== null) return "an object";
  return String(value);
}

/** True for the "the device this frame belongs to is gone" errors raised by the liveness guards. */
function isDeviceGoneError(error: unknown): boolean {
  const code = (error as VGPUError | undefined)?.code;
  return code === "VGPU-DEVICE-DISPOSED" || code === "VGPU-DEVICE-LOST";
}

export class FrameRunner {
  #running = false;
  /**
   * @param trackLoop Lifecycle hook for the owning gpu: called with each started loop handle and
   * returns the untrack function the handle runs when it stops on its own, so `gpu.dispose()` can
   * stop the loops still running without holding on to the ones already stopped.
   */
  constructor(private readonly createFrame: () => Frame, private readonly advance: () => void, private readonly trackLoop?: (handle: FrameLoopHandle) => () => void) {}
  frame(cb?: (frame: Frame) => void): Frame {
    if (this.#running || isSurfaceResizeCallbackActive()) throw frameReentrantError();
    this.#running = true;
    enterFrame();
    try {
      this.advance();
      const frame = this.createFrame();
      if (cb) {
        try { cb(frame); }
        catch (error) {
          // Submit-on-success, cancel-on-throw: a throw means the callback never reached a state it
          // meant to present, so the frame's command buffer is dropped whole rather than submitted
          // half-encoded — and cancel() releases the telemetry retains the encoded passes took. A
          // callback that already submitted (work on the queue, cannot be taken back) or canceled
          // closed the frame itself, so there is nothing to do; asking cancel() would throw
          // VGPU-FRAME-SUBMITTED over the callback's own error. Cleanup can only fail on an
          // internal bug, and even then the original error is what the caller must see.
          if (frameIsOpen(frame)) {
            try { frame.cancel(); }
            catch { /* never mask the callback's error with a cleanup failure */ }
          }
          throw error;
        }
        // A callback is allowed to dispose the owning gpu (gpu.dispose() inside a loop tick does
        // exactly that). dispose() cancels the open frame, so this submit is a no-op; if the device
        // was lost instead, the frame has nothing left to flush either, so the implicit submit
        // swallows that one error rather than throwing over the callback's own intent. An explicit
        // frame.submit() on a dead device still reports it.
        try { frame.submit(); }
        catch (error) { if (!isDeviceGoneError(error)) throw error; }
      }
      return frame;
    } finally {
      leaveFrame();
      this.#running = false;
    }
  }
  loop(cb: FrameLoopCallback, opts: FrameLoopOptions = {}): FrameLoopHandle {
    let stopped = false;
    const request = globalThis.requestAnimationFrame ?? ((fn: FrameRequestCallback) => setTimeout(() => fn(performance.now()), 16) as unknown as number);
    const cancel = globalThis.cancelAnimationFrame ?? ((id: number) => clearTimeout(id));
    const minIntervalMs = opts.fps && opts.fps > 0 ? 1000 / opts.fps : 0;
    let lastFrameMs: number | undefined;
    let id = 0;
    // Registered with the owning gpu so gpu.dispose() stops it: a loop left running would keep
    // encoding frames against a disposed device. Stopping is idempotent and drops the registration.
    let untrack: (() => void) | undefined;
    const stop = () => {
      stopped = true;
      cancel(id);
      untrack?.();
      untrack = undefined;
    };
    const tick = (timestamp: number) => {
      if (stopped) return;
      if (shouldRunFrame(timestamp, lastFrameMs, minIntervalMs)) {
        lastFrameMs = timestamp;
        try { this.frame(cb); }
        catch (error) {
          // The frame was canceled and the error is about to escape the rAF callback, where no
          // caller can catch it and no next tick would be scheduled anyway. Stop the loop properly
          // rather than leave it "running" without ticks and registered with the gpu forever.
          stop();
          throw error;
        }
      }
      // The callback may dispose the owning gpu, which stops this loop while the current tick is
      // running. Do not enqueue one last (no-op) tick after stop() already canceled the old id.
      if (!stopped) id = request(tick);
    };
    id = request(tick);
    const handle: FrameLoopHandle = { stop };
    untrack = this.trackLoop?.(handle);
    return handle;
  }
}

function shouldRunFrame(timestamp: number, lastFrameMs: number | undefined, minIntervalMs: number): boolean {
  if (lastFrameMs === undefined) return true;
  if (minIntervalMs <= 0) return true;
  return timestamp - lastFrameMs >= minIntervalMs;
}
