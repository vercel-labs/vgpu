import type { ExampleMetaDefinition } from '../../lib/example-meta';

export const meta = {
  slug: 'fft-ocean',
  title: 'Particles ocean',
  description: 'A deep-water surface driven by a real inverse FFT. A Phillips spectrum evolves in frequency space, Stockham passes produce a displacement field, and half a million particles ride the waves through an HDR bloom chain.',
  tags: ['ocean', 'fft', 'particles', 'compute'],
  capabilities: ['webgpu', 'compute-shader', 'multi-pass', 'continuous-rendering', 'responsive-canvas'],
  thumb: { warmupFrames: 1, time: 18 },
  files: [
    'index.tsx', 'renderer.ts', 'scene.ts', 'ocean-graph.ts', 'tuning.ts', 'camera.ts',
    'ocean-common.wgsl', 'noise.wgsl', 'initial-spectrum.wgsl', 'spectrum.wgsl', 'ifft-stage.wgsl', 'normal-foam.wgsl',
    'particles.wgsl', 'particles-common.wgsl', 'particles-light.wgsl',
    'bloom-bright.wgsl', 'bloom-blur.wgsl', 'bloom-composite.wgsl', 'present.wgsl', 'stage-preview.wgsl',
  ],
} as const satisfies ExampleMetaDefinition;
