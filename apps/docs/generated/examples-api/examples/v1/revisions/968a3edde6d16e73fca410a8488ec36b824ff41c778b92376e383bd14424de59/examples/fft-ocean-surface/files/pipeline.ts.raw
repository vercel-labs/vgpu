import { compute, draw, effect, geometry, sampler, storage, target } from 'vgpu';

import bake from './bake.wgsl';
import compositeShader from './composite.wgsl';
import fftCol from './fft-col.wgsl';
import fftRow from './fft-row.wgsl';
import oceanSurface from './ocean-surface.wgsl';
import type { OceanApi, OceanShaders } from './scene';
import skydomeShader from './skydome.wgsl';
import spectrumInit from './spectrum-init.wgsl';
import spectrumUpdate from './spectrum-update.wgsl';

export const oceanApi: OceanApi = { compute, storage, draw, geometry, effect, target, sampler };

export const oceanShaders: OceanShaders = {
  spectrumInit,
  spectrumUpdate,
  fftRow,
  fftCol,
  bake,
  oceanSurface,
  skydome: skydomeShader,
  composite: compositeShader,
};

export const OCEAN_CAMERA = {
  fov: 48,
  near: 1,
  far: 8000,
  position: [0, 24, 128] as const,
  target: [0, 5, 0] as const,
};
