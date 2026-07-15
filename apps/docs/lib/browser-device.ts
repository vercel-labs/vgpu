export interface BrowserGpuDeviceOptions {
  readonly powerPreference?: GPUPowerPreference;
  readonly label?: string;
  readonly requiredFeatures?: readonly GPUFeatureName[];
  readonly requiredLimits?: Record<string, number>;
}

export async function requestBrowserGpuDevice(options: BrowserGpuDeviceOptions = {}): Promise<GPUDevice> {
  if (typeof navigator === 'undefined' || !navigator.gpu) {
    throw new Error('WebGPU is not available in this browser.');
  }

  const adapter = await navigator.gpu.requestAdapter({ powerPreference: options.powerPreference });
  if (!adapter) {
    throw new Error('No WebGPU adapter was found.');
  }

  return adapter.requestDevice({
    label: options.label,
    requiredFeatures: options.requiredFeatures ? [...options.requiredFeatures] : undefined,
    requiredLimits: options.requiredLimits,
  });
}

export function preferredCanvasFormat(): GPUTextureFormat {
  return navigator.gpu.getPreferredCanvasFormat();
}
