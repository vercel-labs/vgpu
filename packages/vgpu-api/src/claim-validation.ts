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
 * The returned promise is stored by `Frame` / `Draw.draw()` and awaited after
 * submit. Popping immediately keeps the device-global WebGPU scope stack from
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
 * Awaits raw claimed-bind-group validation collected during encode.
 *
 * No scopes remain open here: native scopes were already popped in LIFO order
 * immediately after each protected encode operation. This promise may reject
 * with `VGPU-R4-GROUP-VALIDATION`; callers must consume `Frame.done` or the
 * `Draw.draw()` return value to avoid unhandled promise rejections.
 */
export function claimedGroupValidationDone(device: Device, results: readonly ClaimedGroupValidationResult[] = []): Promise<void> {
  if (!results.length) return Promise.resolve();
  return settleClaimedGroupValidations(device, results);
}

async function settleClaimedGroupValidations(device: Device, results: readonly ClaimedGroupValidationResult[]): Promise<void> {
  await device.gpu.queue.onSubmittedWorkDone?.();
  const errors: VGPUError[] = [];
  for (const result of results) {
    try {
      const error = await result.error;
      if (error) errors.push(claimedGroupNativeValidationError(result.context.label, result.context.group, error));
    } catch (error) {
      errors.push(claimedGroupNativeValidationError(result.context.label, result.context.group, error));
    }
  }
  if (errors[0]) throw errors[0];
}

function suppressClaimedGroupValidationResult(result: ClaimedGroupValidationResult): void {
  void result.error.catch(() => undefined);
}
