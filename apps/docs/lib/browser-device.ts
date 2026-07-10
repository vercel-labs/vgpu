import { Device, type CreateDeviceOptions } from '@vgpu/core';

export async function createBrowserDevice(options: CreateDeviceOptions = {}): Promise<Device> {
  if (typeof navigator === 'undefined' || !navigator.gpu) {
    throw new Error('WebGPU is not available in this browser.');
  }

  const adapter = await navigator.gpu.requestAdapter({ powerPreference: options.powerPreference });
  if (!adapter) {
    throw new Error('No WebGPU adapter was found.');
  }

  const gpuDevice = await adapter.requestDevice({
    label: options.label,
    requiredFeatures: options.requiredFeatures ? [...options.requiredFeatures] : undefined,
    requiredLimits: options.requiredLimits,
  });

  return new Device(gpuDevice, adapter.info ?? null);
}

export function preferredCanvasFormat(): GPUTextureFormat {
  return navigator.gpu.getPreferredCanvasFormat();
}
