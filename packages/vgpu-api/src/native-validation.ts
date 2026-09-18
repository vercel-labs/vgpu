import type { Device } from "@vgpu/core";
import { compileFailedError, VGPUError } from "./errors.ts";

/** Error scopes are device-global: pop before returning, never across a user callback or await. */
export function nativeScope<T>(device: Device, operation: () => T): { value: T; error: Promise<unknown | null> } {
  const gpu = device.gpu;
  const scoped = typeof gpu.pushErrorScope === "function" && typeof gpu.popErrorScope === "function";
  if (scoped) gpu.pushErrorScope("validation");
  let active = scoped;
  const pop = (): Promise<unknown | null> => {
    if (!active) return Promise.resolve(null);
    active = false;
    try { return gpu.popErrorScope().then(error => error, cause => cause); }
    catch (cause) { return Promise.resolve(cause); }
  };
  try {
    const value = operation();
    return { value, error: pop() };
  } catch (cause) {
    void pop();
    throw cause;
  }
}

const validations = new WeakMap<object, { error: Promise<unknown | null>; claimed: boolean }>();
export function nativeObject<T extends object>(device: Device, create: () => T, dependencies: readonly object[] = []): T {
  let captured: ReturnType<typeof nativeScope<T>>;
  try { captured = nativeScope(device, create); }
  catch (cause) { throw cause instanceof VGPUError ? cause : compileFailedError("pipeline.setup", cause); }
  const { value, error } = captured;
  validations.set(value, { error: Promise.all([objectValidation(dependencies), error]).then(errors => errors.find(Boolean) ?? null), claimed: false });
  return value;
}
export function objectValidation(objects: readonly object[]): Promise<unknown | null> {
  return Promise.all(objects.map(object => {
    const validation = validations.get(object);
    if (validation) validation.claimed = true;
    return validation?.error;
  })).then(errors => errors.find(Boolean) ?? null);
}

/** A later pipeline owns dependency errors; otherwise report failed standalone object creation. */
export async function deliverObjectValidation(object: object, where: string, sink: (error: VGPUError) => void | Promise<void>): Promise<void> {
  const validation = validations.get(object);
  const cause = await validation?.error;
  if (cause && !validation?.claimed) await sink(compileFailedError(where, cause));
}

export interface OperationValidation { readonly error: Promise<unknown | null>; readonly where: string; readonly origin?: () => Promise<unknown | null> }
export function validateOperation<T>(device: Device, results: OperationValidation[], where: string, operation: () => T, origin?: OperationValidation["origin"]): T {
  try {
    const { value, error } = nativeScope(device, operation);
    results.push({ error, where, origin });
    return value;
  } catch (cause) {
    if (cause instanceof VGPUError) throw cause;
    throw operationError(where, cause);
  }
}
export function operationError(where: string, cause: unknown): VGPUError {
  return new VGPUError({ code: "VGPU-COMPUTE-VALIDATION", message: "WebGPU compute operation failed validation.", where, cause, fix: "Check pipeline compilation, resource compatibility, dispatch counts, and device limits." });
}
export async function deliverOperations(results: readonly OperationValidation[], sink: (error: VGPUError) => void | Promise<void>): Promise<void> {
  // Encoding, end, finish and submit may all report one poisoned command buffer. Report its first cause.
  // A backend may defer SetPipeline's error until pass.end(). Await the originating
  // pipeline even when the dispatch scope itself reports no error.
  const origins = await Promise.all(results.map(result => result.origin?.()));
  let reported = false;
  for (const [index, result] of results.entries()) {
    const error = await result.error;
    if (origins[index]) { reported = true; continue; }
    if (!error) continue;
    if (!reported || result.origin) { await sink(operationError(result.where, error)); reported = true; }
  }
}
