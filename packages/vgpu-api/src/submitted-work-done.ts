import type { Device } from "@vgpu/core";

/**
 * Resolves after the device queue reports submitted work completion, when supported.
 *
 * This is feature-guarded because the mock and some compatibility environments may omit
 * `onSubmittedWorkDone`. A synchronous native throw becomes a rejected promise so each caller
 * keeps ownership of its existing completion/error policy.
 */
export function submittedWorkDone(device: Device): Promise<void> {
  try {
    return device.gpu.queue.onSubmittedWorkDone?.() ?? Promise.resolve();
  } catch (error) {
    return Promise.reject(error);
  }
}
