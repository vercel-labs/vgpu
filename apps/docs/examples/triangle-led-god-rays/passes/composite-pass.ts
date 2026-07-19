import type { Device } from 'vgpu';
import { createDrawBundle } from '../pipeline-utils';
import {
  canonicalTriangleGeometry,
  GOD_RAY_DEFAULTS,
  godRayBoundsExpansion,
  PROBE_DISCARD_DEFAULTS,
  type GodRaySettings,
  type ProbeDiscardSettings,
} from '../settings';

export interface CompositeShared {
  pipeline: GPURenderPipeline;
  bindGroupLayout: GPUBindGroupLayout;
  linearSampler: GPUSampler;
  format: GPUTextureFormat;
}

export interface CompositePass {
  encode(encoder: GPUCommandEncoder, inputs: CompositeInputs): void;
  destroy(): void;
}

export interface CompositeInputs {
  bloomIntensity: number;
  probeDiscard?: ProbeDiscardSettings;
  target: GPUTextureView;
  width: number;
  height: number;
  theme?: 'dark' | 'light';
  godRays?: GodRaySettings;
}

export function createCompositePass(
  device: Device,
  shared: CompositeShared,
  sourceView: GPUTextureView,
  bloomView: GPUTextureView,
): CompositePass {
  const uniform = device.createBuffer({
    size: 32,
    usage: ['uniform', 'copy_dst'],
    label: 'triangle-led-4-composite-uniform',
  });
  const bindGroup = device.gpu.createBindGroup({
    layout: shared.bindGroupLayout,
    entries: [
      { binding: 0, resource: { buffer: uniform.gpu } },
      { binding: 1, resource: sourceView },
      { binding: 2, resource: shared.linearSampler },
      { binding: 3, resource: bloomView },
    ],
  });
  const bundle = createDrawBundle(
    device,
    'triangle-led-4-final-compose-bundle',
    shared.format,
    (pass) => {
      pass.setPipeline(shared.pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.draw(3);
    },
  );
  return {
    encode(
      encoder,
      {
        bloomIntensity,
        probeDiscard = PROBE_DISCARD_DEFAULTS,
        target,
        width,
        height,
        theme = 'dark',
        godRays = GOD_RAY_DEFAULTS,
      },
    ) {
      const rayExpansion = godRayBoundsExpansion(
        canonicalTriangleGeometry({ width, height }).circumradius,
        godRays,
        3,
      );
      uniform.write(
        new Float32Array([
          width,
          height,
          bloomIntensity,
          probeDiscard.probeDiscardDistance,
          probeDiscard.lightAabbPadding,
          probeDiscard.lightAabbPadding,
          rayExpansion,
          theme === 'light' ? 1 : 0,
        ]),
      );
      const pass = encoder.beginRenderPass({
        label: 'triangle-led-4-final-compose',
        colorAttachments: [
          {
            view: target,
            loadOp: 'clear',
            storeOp: 'store',
            clearValue: [0, 0, 0, 1],
          },
        ],
      });
      pass.executeBundles([bundle]);
      pass.end();
    },
    destroy() {
      uniform.gpu.destroy();
    },
  };
}
