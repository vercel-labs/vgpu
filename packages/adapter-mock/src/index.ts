import { createMockGPUDevice, Device, validateRequiredFeatures, type CreateDeviceOptions, type VGPUAdapter } from "@vgpu/core";

export interface CreateMockAdapterOptions {
  /** Optional features the mock adapter supports (its equivalent of GPUAdapter.features). requestDevice rejects requiredFeatures outside this set with VGPU-FEATURE-UNSUPPORTED and enables exactly the requested features on the device. Defaults to none. */
  readonly features?: readonly GPUFeatureName[];
}

export function createMockAdapter(options: CreateMockAdapterOptions = {}): VGPUAdapter {
  const supported = new Set<string>(options.features ?? []);
  return {
    async requestDevice(opts?: CreateDeviceOptions): Promise<Device> {
      validateRequiredFeatures(supported, opts?.requiredFeatures);
      // Faithful to WebGPU: device.features holds exactly the requested features, not the adapter's full set.
      return new Device(createMockGPUDevice({ features: opts?.requiredFeatures }), null);
    },
  };
}
