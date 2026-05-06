import { createMockGPUDevice, Device, type CreateDeviceOptions, type VGPUAdapter } from "@vgpu/core";

export function createMockAdapter(): VGPUAdapter {
  return {
    async requestDevice(_opts?: CreateDeviceOptions): Promise<Device> {
      return new Device(createMockGPUDevice(), null);
    },
  };
}
