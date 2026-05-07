import type { Device } from "@vgpu/core";
import type { PassSpec } from "../render-target/types.ts";
import { pass } from "./pass.ts";

export interface PassSequenceOptions {
  readonly encoder?: GPUCommandEncoder;
  readonly device?: Device;
}

/** Runs a list of passes in order with an optional shared encoder. */
export function passSequence(steps: readonly PassSpec[], options?: PassSequenceOptions): void {
  if (steps.length === 0) return;
  if (options?.encoder) {
    for (const step of steps) pass(step.encoder ? step : { ...step, encoder: options.encoder });
    return;
  }
  if (!options?.device) {
    for (const step of steps) pass(step);
    return;
  }

  const encoder = options.device.gpu.createCommandEncoder();
  for (const step of steps) pass(step.encoder ? step : { ...step, encoder });
  options.device.queue.gpu.submit([encoder.finish()]);
}
