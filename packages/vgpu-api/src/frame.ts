import type { Device } from "@vgpu/core";
import { claimedGroupValidationDone, discardClaimedGroupValidationResults, discardClaimedGroupValidationScopes, popLastClaimedGroupValidationScope, preferClaimedGroupValidationResult, pushClaimedGroupValidationScope, submittedWorkDone, type ClaimedGroupValidationResult, type ValidationErrorSink } from "./claim-validation.ts";
import { endRenderPassWithClaimValidation } from "./claim-validation-encode.ts";
import { replayBundles, type Bundle } from "./bundle.ts";
import { encodeDraw, type Draw, type DrawCallOptions } from "./draw.ts";
import { effectDraw, type Effect } from "./effect.ts";
import type { Target } from "./target.ts";
import { claimedGroupNativeValidationError, frameReentrantError, passPreserveMsaaError, surfaceNotInFrameError, targetRequiredError } from "./errors.ts";
import { enterFrame, isSurface, isSurfaceResizeCallbackActive, leaveFrame } from "./surface.ts";
import { isTarget, type ClearColor } from "./target-utils.ts";

export interface FramePassOptions {
  readonly target: Target;
  /** Omit or pass true to clear with gpu.clearColor; pass false to preserve color/depth; pass a color to clear with it. */
  readonly clear?: boolean | ClearColor;
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
  #submitted = false;
  constructor(
    private readonly device: Device,
    private readonly defaultTarget?: Target,
    private readonly errorSink?: ValidationErrorSink,
    private readonly trackSettled?: (promise: Promise<unknown>) => void,
    private readonly defaultClearColor: () => ClearColor = () => [0, 0, 0, 1],
  ) {
    this.#encoder = device.gpu.createCommandEncoder({ label: "vgpu.frame" });
  }

  pass(target: Target, body: Effect | Draw | ((pass: FramePass) => void)): void;
  pass(options: FramePassOptions, body: Effect | Draw | ((pass: FramePass) => void)): void;
  pass(target: Target | FramePassOptions, body: Effect | Draw | ((pass: FramePass) => void)): void {
    const targetOnly = isTarget(target);
    const cb = typeof body === "function" ? body : (p: FramePass) => p.draw(body);
    const resolvedTarget = targetOnly ? target : target.target ?? this.defaultTarget;
    if (!resolvedTarget) throw targetRequiredError("Frame.pass");
    if (isSurface(resolvedTarget) && this.#submitted) throw surfaceNotInFrameError("Frame.pass");
    const clear = targetOnly ? undefined : target.clear;
    const preserve = clear === false;
    if (preserve && resolvedTarget.sampleCount === 4) throw passPreserveMsaaError();
    const encoder = this.#encoder.beginRenderPass(resolvedTarget.renderPassDescriptor(clear === undefined || clear === true || clear === false ? this.defaultClearColor() : clear, preserve));
    try { cb(new FramePass(encoder, resolvedTarget, this.#validations)); }
    catch (error) {
      discardClaimedGroupValidationResults(this.#validations);
      this.#validations.length = 0;
      discardClaimedGroupValidationScopes(this.device);
      try { encoder.end(); } catch { /* ignore cleanup failure after encode failure */ }
      throw error;
    }
    endRenderPassWithClaimValidation(this.device, encoder, this.#validations);
  }

  submit(): void {
    if (this.#submitted) return;
    this.#submitted = true;
    let commandBuffer: GPUCommandBuffer;
    const finishContext = this.#validations[0]?.context;
    if (finishContext) pushClaimedGroupValidationScope(this.device, finishContext);
    try { commandBuffer = this.#encoder.finish(); }
    catch (error) {
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
    this.done = this.#trackDone(claimedGroupValidationDone(this.device, this.#validations, { errorSink: this.errorSink }));
  }

  async #deliverValidationError(label: string, group: number, cause: unknown): Promise<void> {
    await submittedWorkDone(this.device);
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
  constructor(private readonly encoder: GPURenderPassEncoder, readonly target: Target, private readonly validations: ClaimedGroupValidationResult[]) {}
  draw(drawable: Draw | Effect, opts: DrawCallOptions = {}): void {
    encodeFrameDrawable(drawable, this.encoder, this.target, opts, (result) => this.validations.push(result));
  }
  bundles(...bundles: readonly Bundle[]): void {
    replayBundles(this.target, bundles, (gpuBundles) => this.encoder.executeBundles(gpuBundles));
  }
}

function encodeFrameDrawable(drawable: Draw | Effect, encoder: GPURenderPassEncoder, target: Target, opts: DrawCallOptions, claimValidation: (result: ClaimedGroupValidationResult) => void): void {
  if ("layout" in drawable) return encodeDraw(drawable as never, encoder, target, opts, claimValidation);
  encodeDraw(effectDraw(drawable), encoder, target, opts, claimValidation);
}

export class FrameRunner {
  #running = false;
  constructor(private readonly createFrame: () => Frame, private readonly advance: () => void) {}
  frame(cb?: (frame: Frame) => void): Frame {
    if (this.#running || isSurfaceResizeCallbackActive()) throw frameReentrantError();
    this.#running = true;
    enterFrame();
    try {
      this.advance();
      const frame = this.createFrame();
      if (cb) {
        try { cb(frame); }
        finally { frame.submit(); }
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
    const tick = (timestamp: number) => {
      if (stopped) return;
      if (shouldRunFrame(timestamp, lastFrameMs, minIntervalMs)) {
        lastFrameMs = timestamp;
        this.frame(cb);
      }
      id = request(tick);
    };
    id = request(tick);
    return { stop() { stopped = true; cancel(id); } };
  }
}

function shouldRunFrame(timestamp: number, lastFrameMs: number | undefined, minIntervalMs: number): boolean {
  if (lastFrameMs === undefined) return true;
  if (minIntervalMs <= 0) return true;
  return timestamp - lastFrameMs >= minIntervalMs;
}
