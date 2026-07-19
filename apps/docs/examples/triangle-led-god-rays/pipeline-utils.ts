import type { Device } from 'vgpu';
import { compile } from '@vgpu/wgsl';

export function shaderModule(device: Device, source: string): GPUShaderModule {
  return device.createShader(compile(source)).gpu;
}

export function renderPipelineDescriptor(
  label: string,
  module: GPUShaderModule,
  format: GPUTextureFormat,
): GPURenderPipelineDescriptor {
  return {
    label,
    layout: 'auto',
    vertex: { module, entryPoint: 'vs_main' },
    fragment: { module, entryPoint: 'fs_main', targets: [{ format }] },
    primitive: { topology: 'triangle-list' },
  };
}

export async function createRenderPipelineAsync(
  device: Device,
  descriptor: GPURenderPipelineDescriptor,
): Promise<GPURenderPipeline> {
  const gpu = device.gpu as GPUDevice & {
    createRenderPipelineAsync?: (
      descriptor: GPURenderPipelineDescriptor,
    ) => Promise<GPURenderPipeline>;
  };
  if (typeof gpu.createRenderPipelineAsync === 'function')
    return gpu.createRenderPipelineAsync(descriptor);
  return gpu.createRenderPipeline(descriptor);
}

export function createDrawBundle(
  device: Device,
  label: string,
  format: GPUTextureFormat,
  record: (bundle: GPURenderBundleEncoder) => void,
): GPURenderBundle {
  const bundle = device.gpu.createRenderBundleEncoder({
    label,
    colorFormats: [format],
  });
  record(bundle);
  return bundle.finish({ label });
}
