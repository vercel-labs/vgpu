import type { Device, Texture } from 'vgpu';
import { createDrawBundle } from '../pipeline-utils';
import {
  canonicalTriangleGeometry,
  GOD_RAY_DEFAULTS,
  godRayBoundsExpansion,
  PROBE_DISCARD_DEFAULTS,
  type BloomSettings,
  type GodRaySettings,
  type ProbeDiscardSettings,
  type RenderSize,
} from '../settings';

export const BLOOM_FORMAT: GPUTextureFormat = 'rgba16float';

export interface BloomShared {
  pipeline: GPURenderPipeline;
  bindGroupLayout: GPUBindGroupLayout;
  linearSampler: GPUSampler;
}

export interface BloomPass {
  texture: Texture;
  view: GPUTextureView;
  ping: Texture;
  pingView: GPUTextureView;
  encode(encoder: GPUCommandEncoder, inputs: BloomPassInputs): void;
  destroy(): void;
}

export interface BloomPassInputs {
  settings: BloomSettings;
  probeDiscard?: ProbeDiscardSettings;
  theme?: 'dark' | 'light';
  godRays?: GodRaySettings;
}

export function createBloomPass(
  device: Device,
  shared: BloomShared,
  size: RenderSize,
  sourceView: GPUTextureView,
): BloomPass {
  const base = createBloomTexture(device, size, 'triangle-led-4-bloom-base');
  const temp = createBloomTexture(device, size, 'triangle-led-4-bloom-temp');
  const output = createBloomTexture(
    device,
    size,
    'triangle-led-4-bloom-output',
  );
  const baseView = base.createView();
  const tempView = temp.createView();
  const outputView = output.createView();
  const downsampleUniform = device.createBuffer({
    size: 64,
    usage: ['uniform', 'copy_dst'],
    label: 'triangle-led-4-bloom-downsample-uniform',
  });
  const horizontalUniform = device.createBuffer({
    size: 64,
    usage: ['uniform', 'copy_dst'],
    label: 'triangle-led-4-bloom-horizontal-uniform',
  });
  const verticalUniform = device.createBuffer({
    size: 64,
    usage: ['uniform', 'copy_dst'],
    label: 'triangle-led-4-bloom-vertical-uniform',
  });
  const downsampleBindGroup = createBloomBindGroup(
    device,
    shared,
    downsampleUniform.gpu,
    sourceView,
  );
  const horizontalBindGroup = createBloomBindGroup(
    device,
    shared,
    horizontalUniform.gpu,
    baseView,
  );
  const verticalBindGroup = createBloomBindGroup(
    device,
    shared,
    verticalUniform.gpu,
    tempView,
  );

  const downsampleBundle = createDrawBundle(
    device,
    'triangle-led-4-bloom-downsample-bundle',
    BLOOM_FORMAT,
    (pass) => {
      pass.setPipeline(shared.pipeline);
      pass.setBindGroup(0, downsampleBindGroup);
      pass.draw(3);
    },
  );
  const horizontalBundle = createDrawBundle(
    device,
    'triangle-led-4-bloom-horizontal-bundle',
    BLOOM_FORMAT,
    (pass) => {
      pass.setPipeline(shared.pipeline);
      pass.setBindGroup(0, horizontalBindGroup);
      pass.draw(3);
    },
  );
  const verticalBundle = createDrawBundle(
    device,
    'triangle-led-4-bloom-vertical-bundle',
    BLOOM_FORMAT,
    (pass) => {
      pass.setPipeline(shared.pipeline);
      pass.setBindGroup(0, verticalBindGroup);
      pass.draw(3);
    },
  );

  const encodePass = (
    encoder: GPUCommandEncoder,
    targetView: GPUTextureView,
    bundle: GPURenderBundle,
    label: string,
  ) => {
    const pass = encoder.beginRenderPass({
      label,
      colorAttachments: [
        {
          view: targetView,
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: [0, 0, 0, 0],
        },
      ],
    });
    pass.executeBundles([bundle]);
    pass.end();
  };

  return {
    texture: output,
    view: outputView,
    ping: base,
    pingView: baseView,
    encode(encoder, { settings, probeDiscard, theme = 'dark', godRays = GOD_RAY_DEFAULTS }) {
      const bounds = bloomBounds(size, probeDiscard, theme, godRays);
      downsampleUniform.write(
        thresholdUniform(size, settings.threshold, bounds),
      );
      encodePass(
        encoder,
        baseView,
        downsampleBundle,
        'triangle-led-4-bloom-downsample',
      );
      horizontalUniform.write(
        blurUniform(size, settings.threshold, settings.sigma, 1, 0, bounds),
      );
      encodePass(
        encoder,
        tempView,
        horizontalBundle,
        'triangle-led-4-bloom-horizontal',
      );
      verticalUniform.write(
        blurUniform(size, settings.threshold, settings.sigma, 0, 1, bounds),
      );
      encodePass(
        encoder,
        outputView,
        verticalBundle,
        'triangle-led-4-bloom-vertical',
      );
    },
    destroy() {
      base.gpu.destroy();
      temp.gpu.destroy();
      output.gpu.destroy();
      downsampleUniform.gpu.destroy();
      horizontalUniform.gpu.destroy();
      verticalUniform.gpu.destroy();
    },
  };
}

function createBloomBindGroup(
  device: Device,
  shared: BloomShared,
  uniform: GPUBuffer,
  sourceView: GPUTextureView,
) {
  return device.gpu.createBindGroup({
    layout: shared.bindGroupLayout,
    entries: [
      { binding: 0, resource: { buffer: uniform } },
      { binding: 1, resource: sourceView },
      { binding: 2, resource: shared.linearSampler },
    ],
  });
}

function createBloomTexture(device: Device, size: RenderSize, label: string) {
  return device.createTexture({
    size: [size.width, size.height],
    format: BLOOM_FORMAT,
    usage: ['render_attachment', 'texture_binding', 'copy_src'],
    label,
  });
}

const BLOOM_MODE_THRESHOLD = 0;
const BLOOM_MODE_BLUR = 1;

type BloomMode = typeof BLOOM_MODE_THRESHOLD | typeof BLOOM_MODE_BLUR;

function thresholdUniform(
  size: RenderSize,
  threshold: number,
  bounds: BloomBounds,
) {
  return bloomUniform(size, threshold, 0, 0, 0, BLOOM_MODE_THRESHOLD, bounds);
}

function blurUniform(
  size: RenderSize,
  threshold: number,
  sigma: number,
  directionX: number,
  directionY: number,
  bounds: BloomBounds,
) {
  return bloomUniform(
    size,
    threshold,
    sigma,
    directionX,
    directionY,
    BLOOM_MODE_BLUR,
    bounds,
  );
}

function bloomUniform(
  size: RenderSize,
  threshold: number,
  sigma: number,
  directionX: number,
  directionY: number,
  mode: BloomMode,
  bounds: BloomBounds,
) {
  const out = new Float32Array(16);
  out.set([size.width, size.height, 0, 0], 0);
  out.set([directionX, directionY, threshold, sigma], 4);
  out.set([mode, 0, 0, 0], 8);
  out.set([bounds.minX, bounds.minY, bounds.maxX, bounds.maxY], 12);
  return out;
}

interface BloomBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function bloomBounds(
  size: RenderSize,
  probeDiscard: ProbeDiscardSettings = PROBE_DISCARD_DEFAULTS,
  theme: 'dark' | 'light' = 'dark',
  godRays: GodRaySettings = GOD_RAY_DEFAULTS,
): BloomBounds {
  if (theme === 'light') {
    return { minX: 0, minY: 0, maxX: size.width, maxY: size.height };
  }

  const geometry = canonicalTriangleGeometry(size);
  const lightMinX = geometry.left.x - probeDiscard.lightAabbPadding;
  const lightMinY = geometry.top.y - probeDiscard.lightAabbPadding;
  const lightMaxX = geometry.right.x + probeDiscard.lightAabbPadding;
  const lightMaxY = geometry.left.y + probeDiscard.lightAabbPadding;
  const lightWidth = lightMaxX - lightMinX;
  const lightHeight = lightMaxY - lightMinY;
  const discardMargin =
    probeDiscard.probeDiscardDistance * 1.5 * Math.max(lightWidth, lightHeight);
  const blurMargin = 3;
  const rayMargin = godRayBoundsExpansion(
    geometry.circumradius,
    godRays,
    blurMargin,
  );
  const margin = discardMargin + blurMargin + rayMargin;

  return {
    minX: Math.max(0, lightMinX - margin),
    minY: Math.max(0, lightMinY - margin),
    maxX: Math.min(size.width, lightMaxX + margin),
    maxY: Math.min(size.height, lightMaxY + margin),
  };
}
