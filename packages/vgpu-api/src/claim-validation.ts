import type { Device } from "@vgpu/core";
import { claimedGroupNativeValidationError, type VGPUError } from "./errors.ts";

export interface ClaimedGroupValidationContext {
  readonly label: string;
  readonly group: number;
}

const pendingScopes = new WeakMap<GPUDevice, ClaimedGroupValidationContext[]>();

export function pushClaimedGroupValidationScope(device: Device, context: ClaimedGroupValidationContext): void {
  if (!device.gpu.pushErrorScope || !device.gpu.popErrorScope) return;
  device.gpu.pushErrorScope("validation");
  const pending = pendingScopes.get(device.gpu);
  if (pending) pending.push(context);
  else pendingScopes.set(device.gpu, [context]);
}

export function claimedGroupValidationDone(device: Device): Promise<void> {
  const pending = pendingScopes.get(device.gpu);
  if (!pending?.length) return Promise.resolve();
  pendingScopes.delete(device.gpu);
  return popClaimedGroupValidationScopes(device, pending);
}

export function discardLastClaimedGroupValidationScope(device: Device): void {
  const pending = pendingScopes.get(device.gpu);
  if (!pending?.length) return;
  pending.pop();
  if (!pending.length) pendingScopes.delete(device.gpu);
  void device.gpu.popErrorScope();
}

export function discardClaimedGroupValidationScopes(device: Device): void {
  const pending = pendingScopes.get(device.gpu);
  if (!pending?.length) return;
  pendingScopes.delete(device.gpu);
  for (let index = pending.length - 1; index >= 0; index -= 1) void device.gpu.popErrorScope();
}

async function popClaimedGroupValidationScopes(device: Device, pending: readonly ClaimedGroupValidationContext[]): Promise<void> {
  await device.gpu.queue.onSubmittedWorkDone?.();
  const errors: VGPUError[] = [];
  for (let index = pending.length - 1; index >= 0; index -= 1) {
    const context = pending[index]!;
    const error = await device.gpu.popErrorScope();
    if (error) errors.push(claimedGroupNativeValidationError(context.label, context.group, error));
  }
  if (errors[0]) throw errors[0];
}
