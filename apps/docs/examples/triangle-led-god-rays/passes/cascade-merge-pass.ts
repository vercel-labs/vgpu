import type { Device, Texture } from 'vgpu';
import { CASCADE_FORMAT } from './cascade-build-pass';
import { createDrawBundle } from '../pipeline-utils';
import {
  CASCADE0_DIMS,
  CASCADE0_RANGE,
  PROBE_DISCARD_DEFAULTS,
  type CascadeFitRect,
  type ProbeDiscardSettings,
  type RenderSize,
} from '../settings';

export interface CascadeMergeShared {
  pipeline: GPURenderPipeline;
  bindGroupLayout: GPUBindGroupLayout;
}

export interface CascadeMergePass {
  texture: Texture;
  view: GPUTextureView;
  bindNext(nextView: GPUTextureView): void;
  encode(encoder: GPUCommandEncoder, settings?: ProbeDiscardSettings): void;
  destroy(): void;
}

export function createCascadeMergePass(
  device: Device,
  shared: CascadeMergeShared,
  level: number,
  count: number,
  lightSourcesSize: RenderSize,
  size: RenderSize,
  cascadeFit: CascadeFitRect,
  realView: GPUTextureView,
): CascadeMergePass {
  const texture = device.createTexture({
    size: [size.width, size.height],
    format: CASCADE_FORMAT,
    usage: ['render_attachment', 'texture_binding', 'copy_src'],
    label: `triangle-led-4-cascade-merged-${level}`,
  });
  const view = texture.createView();
  const uniform = device.createBuffer({
    size: 80,
    usage: ['uniform', 'copy_dst'],
    label: `triangle-led-4-cascade-merge-uniform-${level}`,
  });
  let currentSettings = { ...PROBE_DISCARD_DEFAULTS };
  uniform.write(
    mergeUniform(level, count, lightSourcesSize, size, cascadeFit, currentSettings),
  );
  let bindGroup: GPUBindGroup | undefined;
  let bundle: GPURenderBundle | undefined;
  return {
    texture,
    view,
    bindNext(nextView) {
      const nextBindGroup = device.gpu.createBindGroup({
        layout: shared.bindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: uniform.gpu } },
          { binding: 1, resource: realView },
          { binding: 2, resource: nextView },
        ],
      });
      bindGroup = nextBindGroup;
      bundle = createDrawBundle(
        device,
        `triangle-led-4-cascade-merge-bundle-${level}`,
        CASCADE_FORMAT,
        (pass) => {
          pass.setPipeline(shared.pipeline);
          pass.setBindGroup(0, nextBindGroup);
          pass.draw(3);
        },
      );
    },
    encode(encoder, settings = PROBE_DISCARD_DEFAULTS) {
      if (
        settings.lightAabbPadding !== currentSettings.lightAabbPadding ||
        settings.probeDiscardDistance !== currentSettings.probeDiscardDistance
      ) {
        currentSettings = { ...settings };
        uniform.write(
          mergeUniform(
            level,
            count,
            lightSourcesSize,
            size,
            cascadeFit,
            currentSettings,
          ),
        );
      }
      if (!bindGroup || !bundle)
        throw new Error(
          `triangle-led-4-cascade-merge-${level} bindNext() was not called`,
        );
      const pass = encoder.beginRenderPass({
        label: `triangle-led-4-cascade-merge-${level}`,
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

function mergeUniform(
  level: number,
  count: number,
  lightSourcesSize: RenderSize,
  size: RenderSize,
  cascadeFit: CascadeFitRect,
  settings: ProbeDiscardSettings,
) {
  const out = new Float32Array(20);
  out.set([lightSourcesSize.width, lightSourcesSize.height, 0, 0], 0);
  out.set([size.width, size.height, 0, 0], 4);
  out.set([CASCADE0_DIMS, CASCADE0_RANGE, level, count], 8);
  out.set([settings.lightAabbPadding, settings.probeDiscardDistance, 0, 0], 12);
  out.set(
    [
      cascadeFit.originSceneX,
      cascadeFit.originSceneY,
      cascadeFit.fullWidth,
      cascadeFit.fullHeight,
    ],
    16,
  );
  return out;
}
