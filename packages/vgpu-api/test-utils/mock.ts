import { createMockAdapter, init as initMock } from "../src/mock.ts";
import type { Gpu, InitOptions } from "../src/init.ts";
import { getMockGPUDeviceInstrumentation, type MockGPUDeviceInstrumentation } from "@vgpu/core";

export { createMockAdapter, getMockGPUDeviceInstrumentation };
export type { MockGPUDeviceInstrumentation };

/** Boots a GPU-less `vgpu/mock` instance for unit tests that must not load Dawn. */
export function createMockGpu(options?: InitOptions): Promise<Gpu> {
  return initMock(options);
}

/** Returns instrumentation counters for a GPU created through {@link createMockGpu}. */
export function getMockDeviceInstrumentation(gpu: Gpu): MockGPUDeviceInstrumentation {
  return getMockGPUDeviceInstrumentation(gpu.device.gpu);
}
