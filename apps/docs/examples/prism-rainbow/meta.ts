import type { ExampleMetaDefinition } from '../../lib/example-meta';

export const meta = {
  slug: 'prism-rainbow',
  title: 'Prism Rainbow',
  description:
    'A spectral path tracer in two dimensions: every fragment fires 16 rays at random points across the glass, refracts each one through the prism, and keeps the ones that come out aimed at the lamp. Temporal accumulation turns that noise into a rainbow.',
  tags: ['lighting', 'raycasting', 'rendering', 'shader', 'animation'],
  capabilities: [
    'webgpu',
    'fragment-shader',
    'multi-pass',
    'render-targets',
    'textures',
    'continuous-rendering',
    'pointer-input',
    'controls',
    'select-control',
    'checkbox-controls',
    'responsive-canvas',
  ],
  // The picture is a function of how many frames were averaged and nothing else
  // — no clock is read anywhere — so a fixed frame count is reproducible.
  thumb: {
    warmupFrames: 600,
    note: 'Six hundred accumulated frames of the real trace and present passes; the estimate is a function of the frame count alone, so this render is deterministic.',
  },
  files: [
    'index.tsx',
    'controls.tsx',
    'renderer.ts',
    'scene.ts',
    'types.ts',
    'optics.ts',
    'validation.ts',
    'optics.wgsl',
    'scene.wgsl',
    'trace.wgsl',
    'present.wgsl',
    'probe.wgsl',
  ],
} as const satisfies ExampleMetaDefinition;
