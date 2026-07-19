import type { Device, Texture } from 'vgpu';
import { createDrawBundle } from '../pipeline-utils';
import {
  CASCADE0_DIMS,
  CASCADE0_RANGE,
  PROBE_DISCARD_DEFAULTS,
  TUNABLE_DEFAULTS,
  triangleLedRadius,
  type CascadeFitRect,
  type ProbeDiscardSettings,
  type RenderSize,
} from '../settings';

export const CASCADE_FORMAT: GPUTextureFormat = 'rgba16float';

export interface CascadeBuildShared {
  pipeline: GPURenderPipeline;
  bindGroupLayout: GPUBindGroupLayout;
}

export interface CascadeBuildPass {
  texture: Texture;
  view: GPUTextureView;
  encode(
    encoder: GPUCommandEncoder,
    settings?: ProbeDiscardSettings,
    ledHitThreshold?: number,
  ): void;
  destroy(): void;
}

export function createCascadeBuildPass(
  device: Device,
  shared: CascadeBuildShared,
  level: number,
  count: number,
  lightSourcesSize: RenderSize,
  cascadeSize: RenderSize,
  cascadeFit: CascadeFitRect,
  lightSourcesView: GPUTextureView,
): CascadeBuildPass {
  const ledRadius = triangleLedRadius(lightSourcesSize);
  const texture = device.createTexture({
    size: [cascadeSize.width, cascadeSize.height],
    format: CASCADE_FORMAT,
    usage: ['render_attachment', 'texture_binding', 'copy_src'],
    label: `triangle-led-4-cascade-real-${level}`,
  });
  const view = texture.createView();
  const uniform = device.createBuffer({
    size: 80,
    usage: ['uniform', 'copy_dst'],
    label: `triangle-led-4-cascade-build-uniform-${level}`,
  });
  let currentSettings = { ...PROBE_DISCARD_DEFAULTS };
  uniform.write(
    cascadeUniform(
      level,
      count,
      lightSourcesSize,
      cascadeSize,
      cascadeFit,
      currentSettings,
      ledRadius,
      TUNABLE_DEFAULTS.ledHitThreshold,
    ),
  );
  const bindGroup = device.gpu.createBindGroup({
    layout: shared.bindGroupLayout,
    entries: [
      { binding: 0, resource: { buffer: uniform.gpu } },
      { binding: 1, resource: lightSourcesView },
    ],
  });
  const bundle = createDrawBundle(
    device,
    `triangle-led-4-cascade-build-bundle-${level}`,
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
    encode(
      encoder,
      settings = PROBE_DISCARD_DEFAULTS,
      ledHitThreshold = TUNABLE_DEFAULTS.ledHitThreshold,
    ) {
      if (
        settings.lightAabbPadding !== currentSettings.lightAabbPadding ||
        settings.probeDiscardDistance !== currentSettings.probeDiscardDistance
      ) {
        currentSettings = { ...settings };
      }
      uniform.write(
        cascadeUniform(
          level,
          count,
          lightSourcesSize,
          cascadeSize,
          cascadeFit,
          currentSettings,
          ledRadius,
          ledHitThreshold,
        ),
      );
      const pass = encoder.beginRenderPass({
        label: `triangle-led-4-cascade-build-${level}`,
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

function cascadeUniform(
  level: number,
  count: number,
  lightSourcesSize: RenderSize,
  cascadeSize: RenderSize,
  cascadeFit: CascadeFitRect,
  settings: ProbeDiscardSettings,
  ledRadius: number,
  ledHitThreshold: number,
) {
  const out = new Float32Array(20);
  out.set([lightSourcesSize.width, lightSourcesSize.height, 0, 0], 0);
  out.set([cascadeSize.width, cascadeSize.height, 0, 0], 4);
  out.set([CASCADE0_DIMS, CASCADE0_RANGE, level, count], 8);
  out.set(
    [
      settings.lightAabbPadding,
      settings.probeDiscardDistance,
      ledRadius,
      ledHitThreshold,
    ],
    12,
  );
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
