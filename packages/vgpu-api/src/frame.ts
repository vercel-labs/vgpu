import type { Device } from "@vgpu/core";
import { claimedGroupValidationDone, discardClaimedGroupValidationResults, discardClaimedGroupValidationScopes, popClaimedGroupValidationScopes, popLastClaimedGroupValidationScope, pushClaimedGroupValidationScope, type ClaimedGroupValidationResult } from "./claim-validation.ts";
import { replayBundles, type Bundle } from "./bundle.ts";
import { Draw, type DrawCallOptions } from "./draw.ts";
import { Pass } from "./pass.ts";
import type { Target } from "./target.ts";
import { claimedGroupNativeValidationError, missingScreenError } from "./errors.ts";

export interface FramePassOptions {
  readonly target?: Target;
  readonly clear?: GPUColor | readonly [number, number, number, number];
}

export interface FrameLoopHandle { stop(): void }
export type FrameLoopCallback = (frame: Frame) => void;

export class Frame {
  /**
   * Resolves after submit-time validation for raw claimed bind groups has been checked.
   *
   * Consume this promise when encoding raw claimed bind groups; otherwise native
   * validation failures may surface as unhandled promise rejections. Metadata-backed
   * claims bypass this path and add no validation-scope work.
   */
  done: Promise<void> = Promise.resolve();
  private readonly encoder: GPUCommandEncoder;
  private readonly validations: ClaimedGroupValidationResult[] = [];
  private submitted = false;
  constructor(private readonly device: Device, private readonly defaultTarget?: Target) {
    this.encoder = device.gpu.createCommandEncoder({ label: "vgpu.frame" });
  }

  pass(opts: FramePassOptions, cb: (pass: FramePass) => void): void {
    const target = opts.target ?? this.defaultTarget;
    if (!target) throw missingScreenError();
    const encoder = this.encoder.beginRenderPass(target.renderPassDescriptor(opts.clear));
    try { cb(new FramePass(encoder, target, this.validations)); }
    catch (error) {
      discardClaimedGroupValidationResults(this.validations);
      this.validations.length = 0;
      discardClaimedGroupValidationScopes(this.device);
      try { encoder.end(); } catch { /* ignore cleanup failure after encode failure */ }
      throw error;
    }
    try { encoder.end(); }
    catch (error) {
      const scopes = popClaimedGroupValidationScopes(this.device);
      discardClaimedGroupValidationResults(this.validations);
      discardClaimedGroupValidationResults(scopes);
      this.validations.length = 0;
      const context = scopes[0]?.context;
      if (context) throw claimedGroupNativeValidationError(context.label, context.group, error);
      throw error;
    }
  }

  submit(): void {
    if (this.submitted) return;
    this.submitted = true;
    let commandBuffer: GPUCommandBuffer;
    const finishContext = this.validations[0]?.context;
    if (finishContext) pushClaimedGroupValidationScope(this.device, finishContext);
    try { commandBuffer = this.encoder.finish(); }
    catch (error) {
      const result = finishContext ? popLastClaimedGroupValidationScope(this.device) : undefined;
      discardClaimedGroupValidationResults(this.validations);
      if (result) discardClaimedGroupValidationResults([result]);
      const context = result?.context ?? finishContext;
      if (!context) throw error;
      this.done = Promise.reject(claimedGroupNativeValidationError(context.label, context.group, error));
      return;
    }
    if (finishContext) {
      const result = popLastClaimedGroupValidationScope(this.device);
      if (result) this.validations.push(result);
    }
    const submitContext = this.validations[0]?.context;
    if (submitContext) pushClaimedGroupValidationScope(this.device, submitContext);
    try { this.device.gpu.queue.submit([commandBuffer]); }
    catch (error) {
      const result = submitContext ? popLastClaimedGroupValidationScope(this.device) : undefined;
      discardClaimedGroupValidationResults(this.validations);
      if (result) discardClaimedGroupValidationResults([result]);
      const context = result?.context ?? submitContext;
      if (!context) throw error;
      this.done = Promise.reject(claimedGroupNativeValidationError(context.label, context.group, error));
      return;
    }
    if (submitContext) {
      const result = popLastClaimedGroupValidationScope(this.device);
      if (result) this.validations.push(result);
    }
    this.done = claimedGroupValidationDone(this.device, this.validations);
  }
}

export class FramePass {
  constructor(private readonly encoder: GPURenderPassEncoder, readonly target: Target, private readonly validations: ClaimedGroupValidationResult[]) {}
  draw(drawable: Draw | Pass, opts: DrawCallOptions = {}): void {
    drawable.encode(this.encoder, this.target, opts, (result) => this.validations.push(result));
  }
  bundles(...bundles: readonly Bundle[]): void {
    replayBundles(this.target, bundles, (gpuBundles) => this.encoder.executeBundles(gpuBundles));
  }
}

export class FrameRunner {
  constructor(private readonly createFrame: () => Frame, private readonly advance: () => void) {}
  frame(cb?: (frame: Frame) => void): Frame {
    this.advance();
    const frame = this.createFrame();
    if (cb) {
      try { cb(frame); }
      finally { frame.submit(); }
    }
    return frame;
  }
  loop(cb: FrameLoopCallback): FrameLoopHandle {
    let stopped = false;
    const request = globalThis.requestAnimationFrame ?? ((fn: FrameRequestCallback) => setTimeout(() => fn(performance.now()), 16) as unknown as number);
    const cancel = globalThis.cancelAnimationFrame ?? ((id: number) => clearTimeout(id));
    let id = 0;
    const tick = () => {
      if (stopped) return;
      const frame = this.frame();
      try { cb(frame); }
      finally { frame.submit(); }
      id = request(tick);
    };
    id = request(tick);
    return { stop() { stopped = true; cancel(id); } };
  }
}
