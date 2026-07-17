import type { Device } from "@vgpu/core";
import { claimedGroupNativeValidationError, type VGPUError } from "./errors.ts";

export interface ClaimedGroupValidationContext {
  readonly label: string;
  readonly group: number;
}

export interface ClaimedGroupValidationResult {
  readonly context: ClaimedGroupValidationContext;
  readonly error: Promise<GPUError | null>;
}

export type ValidationErrorSink = (error: VGPUError) => void | Promise<void>;

export interface ClaimedGroupValidationDoneOptions {
  readonly errorSink?: ValidationErrorSink;
}

const pendingScopes = new WeakMap<GPUDevice, ClaimedGroupValidationContext[]>();

/**
 * Opens a native WebGPU validation scope for one raw claimed bind group.
 *
 * WebGPU error scopes are device-global and strictly LIFO, so callers must pair
 * this with `popLastClaimedGroupValidationScope()` immediately after the small
 * protected encode operation. Metadata-backed claims bypass this helper because
 * vgpu can validate their layout synchronously and the normal path should not
 * pay for native error scopes.
 */
export function pushClaimedGroupValidationScope(device: Device, context: ClaimedGroupValidationContext): void {
  if (!device.gpu.pushErrorScope || !device.gpu.popErrorScope) return;
  device.gpu.pushErrorScope("validation");
  const pending = pendingScopes.get(device.gpu);
  if (pending) pending.push(context);
  else pendingScopes.set(device.gpu, [context]);
}

/**
 * Pops the most recent raw-claim scope in native LIFO order and returns its promise.
 *
 * The returned promise is delivered through `gpu.onError` and tracked by
 * `Frame.done` / `gpu.settled()` after submit. Popping immediately keeps the device-global WebGPU scope stack from
 * being shared accidentally by overlapping frames or one-shot draws.
 */
export function popLastClaimedGroupValidationScope(device: Device): ClaimedGroupValidationResult | undefined {
  const pending = pendingScopes.get(device.gpu);
  if (!pending?.length || !device.gpu.popErrorScope) return undefined;
  const context = pending.pop()!;
  if (!pending.length) pendingScopes.delete(device.gpu);
  return { context, error: device.gpu.popErrorScope() };
}

/**
 * Pops every currently open raw-claim scope for this device in native LIFO order.
 *
 * Device-global WebGPU error scopes are not an ownership/collection boundary;
 * this exists only for abort paths that must drain scopes left open by a failed
 * protected encode region before rethrowing.
 *
 * @internal
 */
export function popClaimedGroupValidationScopes(device: Device): readonly ClaimedGroupValidationResult[] {
  const results: ClaimedGroupValidationResult[] = [];
  let result = popLastClaimedGroupValidationScope(device);
  while (result) {
    results.push(result);
    result = popLastClaimedGroupValidationScope(device);
  }
  return results;
}

/** Discards one open raw-claim scope after a synchronous encode failure. */
export function discardLastClaimedGroupValidationScope(device: Device): void {
  const result = popLastClaimedGroupValidationScope(device);
  if (result) suppressClaimedGroupValidationResult(result);
}

/**
 * Discards every currently open raw-claim scope for this device after aborting an encode region.
 *
 * This is intentionally device-global and abort-only: normal validation owners
 * pop scopes immediately and store the returned promises on their frame/draw.
 *
 * @internal
 */
export function discardClaimedGroupValidationScopes(device: Device): void {
  for (const result of popClaimedGroupValidationScopes(device)) suppressClaimedGroupValidationResult(result);
}

/** Suppresses already-popped validation promises when their frame/draw will not submit. */
export function discardClaimedGroupValidationResults(results: readonly ClaimedGroupValidationResult[]): void {
  for (const result of results) suppressClaimedGroupValidationResult(result);
}

/**
 * Resolves after the device queue reports submitted work completion, when supported.
 *
 * This is feature-guarded because the mock and some compatibility environments
 * may omit `onSubmittedWorkDone`.
 */
export function submittedWorkDone(device: Device): Promise<void> {
  return device.gpu.queue.onSubmittedWorkDone?.() ?? Promise.resolve();
}

/**
 * Awaits raw claimed-bind-group validation collected during encode.
 *
 * No scopes remain open here: native scopes were already popped in LIFO order
 * immediately after each protected encode operation. Validation errors are
 * delivered to the supplied device-level error sink as `VGPU-R4-GROUP-VALIDATION`;
 * this promise resolves after delivery and never rejects.
 */
export function claimedGroupValidationDone(device: Device, results: readonly ClaimedGroupValidationResult[] = [], opts: ClaimedGroupValidationDoneOptions = {}): Promise<void> {
  return settleClaimedGroupValidations(device, results, opts.errorSink ?? defaultErrorSink);
}

export function preferClaimedGroupValidationResult(preferred: ClaimedGroupValidationResult, fallback: ClaimedGroupValidationResult): ClaimedGroupValidationResult {
  return {
    context: preferred.context,
    error: preferValidationError(preferred.error, fallback.error),
  };
}

async function preferValidationError(preferred: Promise<GPUError | null>, fallback: Promise<GPUError | null>): Promise<GPUError | null> {
  const results = await Promise.allSettled([preferred, fallback]);
  for (const result of results) {
    if (result.status === "fulfilled" && result.value) return result.value;
  }
  const rejection = results.find((result) => result.status === "rejected");
  if (rejection?.status === "rejected") throw rejection.reason;
  return null;
}

async function settleClaimedGroupValidations(device: Device, results: readonly ClaimedGroupValidationResult[], errorSink: ValidationErrorSink): Promise<void> {
  await submittedWorkDone(device);
  for (const result of results) {
    try {
      const error = await result.error;
      if (error) await errorSink(claimedGroupNativeValidationError(result.context.label, result.context.group, error));
    } catch (error) {
      await errorSink(claimedGroupNativeValidationError(result.context.label, result.context.group, error));
    }
  }
}

function suppressClaimedGroupValidationResult(result: ClaimedGroupValidationResult): void {
  void result.error.catch(() => undefined);
}

function defaultErrorSink(error: VGPUError): void {
  console.error(error);
}
