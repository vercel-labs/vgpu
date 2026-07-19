import type { Device, Texture } from 'vgpu';
import { CASCADE_FORMAT } from './cascade-build-pass';
import { createDrawBundle } from '../pipeline-utils';
import { CASCADE0_DIMS, type RenderSize } from '../settings';

export interface RadianceFieldShared {
  pipeline: GPURenderPipeline;
  bindGroupLayout: GPUBindGroupLayout;
}

export interface RadianceFieldPass {
  texture: Texture;
  view: GPUTextureView;
  encode(encoder: GPUCommandEncoder): void;
  destroy(): void;
}

export function createRadianceFieldPass(
  device: Device,
  shared: RadianceFieldShared,
  cascadeSize: RenderSize,
  merged0View: GPUTextureView,
): RadianceFieldPass {
  const fieldSize = {
    width: Math.max(1, Math.floor(cascadeSize.width / CASCADE0_DIMS)),
    height: Math.max(1, Math.floor(cascadeSize.height / CASCADE0_DIMS)),
  };
  const texture = device.createTexture({
    size: [fieldSize.width, fieldSize.height],
    format: CASCADE_FORMAT,
    usage: ['render_attachment', 'texture_binding', 'copy_src'],
    label: 'triangle-led-4-radiance-field',
  });
  const view = texture.createView();
  const uniform = device.createBuffer({
    size: 32,
    usage: ['uniform', 'copy_dst'],
    label: 'triangle-led-4-radiance-field-uniform',
  });
  const data = new Float32Array(8);
  data.set([cascadeSize.width, cascadeSize.height, 0, 0], 0);
  data.set([CASCADE0_DIMS, 0, 0, 0], 4);
  uniform.write(data);
  const bindGroup = device.gpu.createBindGroup({
    layout: shared.bindGroupLayout,
    entries: [
      { binding: 0, resource: { buffer: uniform.gpu } },
      { binding: 1, resource: merged0View },
    ],
  });
  const bundle = createDrawBundle(
    device,
    'triangle-led-4-radiance-field-bundle',
    CASCADE_FORMAT,
    (pass) => {
      pass.setPipeline(shared.pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.draw(3);
    },
  );
  return {
    texture,
    view,
    encode(encoder) {
      const pass = encoder.beginRenderPass({
        label: 'triangle-led-4-radiance-field',
        colorAttachments: [
          { view, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] },
        ],
      });
      pass.executeBundles([bundle]);
      pass.end();
    },
    destroy() {
      texture.gpu.destroy();
    },
  };
}
