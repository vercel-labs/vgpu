import type { ExampleMetaDefinition } from '../../lib/example-meta';

export const meta = {
  slug: 'environment-map',
  title: 'Environment Map',
  description:
    'One 360° equirectangular map lights the whole scene: it is the background and every reflection on a mirror-metal cube floating in it.',
  tags: ['lighting', 'hdr', 'rendering'],
  capabilities: ['webgpu', 'pointer-orbit', 'multi-pass', 'continuous-rendering', 'responsive-canvas', 'textures'],
  thumb: { warmupFrames: 3, dt: 1 / 60, time: 2.1 },
  files: [
    'index.tsx', 'renderer.ts', 'camera.ts', 'pointer-input.ts',
    'sky.wgsl', 'blur.wgsl', 'metal.wgsl', 'present.wgsl', 'env-common.wgsl',
  ],
} as const satisfies ExampleMetaDefinition;
