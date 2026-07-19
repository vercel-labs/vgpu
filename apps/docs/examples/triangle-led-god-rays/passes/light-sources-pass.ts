import type { Buffer, Device, Texture } from 'vgpu';
import { createDrawBundle } from '../pipeline-utils';
import {
  canonicalTriangleGeometry,
  triangleLedRadius,
  type RenderSize,
  type BrushSettings,
} from '../settings';

export const LIGHT_SOURCES_FORMAT: GPUTextureFormat = 'rgba16float';

export interface BrushState extends BrushSettings {
  x: number;
  y: number;
  active: boolean;
}

export interface SceneTunables {
  floorAlbedo: number;
  ledIntensity: number;
  noiseScale: number;
  rotationSpeed: number;
  brightnessMin: number;
  brightnessMax: number;
  ledHitThreshold: number;
}

export interface LightSourcesShared {
  pipeline: GPURenderPipeline;
  bindGroupLayout: GPUBindGroupLayout;
}

export interface LightSourcesPass {
  texture: Texture;
  view: GPUTextureView;
  encode(
    encoder: GPUCommandEncoder,
    brush: BrushState,
    time: number,
    tunables: SceneTunables,
    renderBlackOccluder?: boolean,
  ): void;
  destroy(): void;
}

/**
 * Renders the low-resolution emitter/SDF input consumed by the cascade passes.
 * This is not the final visible scene; it stores LED light sources and occluder distance data.
 */
export function createLightSourcesPass(
  device: Device,
  shared: LightSourcesShared,
  size: RenderSize,
  leds: Buffer,
): LightSourcesPass {
  const ledRadius = triangleLedRadius(size);
  const triangle = canonicalTriangleGeometry(size);
  const texture = device.createTexture({
    size: [size.width, size.height],
    format: LIGHT_SOURCES_FORMAT,
    usage: ['render_attachment', 'texture_binding', 'copy_src'],
    label: 'triangle-led-4-light-sources',
  });
  const view = texture.createView();
  const uniform = device.createBuffer({
    size: 96,
    usage: ['uniform', 'copy_dst'],
    label: 'triangle-led-4-light-sources-uniform',
  });
  const bindGroup = device.gpu.createBindGroup({
    layout: shared.bindGroupLayout,
    entries: [
      { binding: 0, resource: { buffer: uniform.gpu } },
      { binding: 1, resource: { buffer: leds.gpu } },
    ],
  });
  const bundle = createDrawBundle(
    device,
    'triangle-led-4-light-sources-bundle',
    LIGHT_SOURCES_FORMAT,
    (pass) => {
      pass.setPipeline(shared.pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.draw(3);
    },
  );
  return {
    texture,
    view,
    encode(encoder, brush, time, tunables, renderBlackOccluder = true) {
      uniform.write(
        lightSourcesUniform(
          size,
          brush,
          time,
          tunables,
          ledRadius,
          triangle,
          renderBlackOccluder,
        ),
      );
      const pass = encoder.beginRenderPass({
        label: 'triangle-led-4-light-sources-pass',
        colorAttachments: [
          {
            view,
            loadOp: 'clear',
            storeOp: 'store',
            clearValue: [0, 0, 0, 1000],
          },
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

function lightSourcesUniform(
  size: RenderSize,
  brush: BrushState,
  time: number,
  tunables: SceneTunables,
  ledRadius: number,
  triangle: ReturnType<typeof canonicalTriangleGeometry>,
  renderBlackOccluder: boolean,
) {
  const out = new Float32Array(24);
  out.set([size.width, size.height, time, tunables.floorAlbedo], 0);
  out.set([brush.x, brush.y, brush.active ? 1 : 0, brush.radius], 4);
  out.set([brush.colour.r, brush.colour.g, brush.colour.b, 0], 8);
  out.set(
    [
      tunables.ledIntensity,
      tunables.brightnessMin,
      tunables.brightnessMax,
      ledRadius,
    ],
    12,
  );
  out.set(
    [
      triangle.center.x,
      triangle.center.y,
      triangle.circumradius,
      triangle.sideLength * 0.5,
    ],
    16,
  );
  out.set([renderBlackOccluder ? 1 : 0, tunables.ledHitThreshold, 0, 0], 20);
  return out;
}
