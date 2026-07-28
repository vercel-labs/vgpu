import type { ExampleMetaDefinition } from '../../lib/example-meta';

export const meta = {
  slug: 'nextjs-flare',
  title: 'Next.js Flare',
  description:
    'Next.js logo shader — a rim-lit N glyph with volumetric scattering: a 48-step ray walk jittered by blue noise over a separable Gaussian blur chain, breathing autonomously until the pointer takes over.',
  tags: ['flare', 'volumetric', 'lighting', 'animation'],
  capabilities: [
    'webgpu',
    'multi-pass',
    'pointer-input',
    'textures',
    'continuous-rendering',
    'responsive-canvas',
  ],
  thumb: { time: 4.2 },
  files: [
    'index.tsx',
    'renderer.ts',
    'pipeline.ts',
    'uniforms.ts',
    'settings.ts',
    'animation.ts',
    'blur-kernel.ts',
    'textures.ts',
    'logo-raster.ts',
    'fullscreen.ts',
    'logo.wgsl',
    'rim.wgsl',
    'blur.wgsl',
    'composite.wgsl',
  ],
} as const satisfies ExampleMetaDefinition;
