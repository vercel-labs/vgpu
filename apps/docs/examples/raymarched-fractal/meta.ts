import type { ExampleMetaDefinition } from '../../lib/example-meta';

export const meta = {
  slug: 'raymarched-fractal',
  title: 'Raymarched fractal',
  description: 'A raymarched Sierpiński tetrahedron emerges from pure black under directional light and restrained HDR bloom, with drag-only orbit controls.',
  tags: ['raymarching', 'raymarch', 'fractal', 'sierpinski', 'hdr', 'bloom'],
  capabilities: ['webgpu', 'demand-rendering', 'pointer-orbit', 'multi-pass', 'responsive-canvas'],
  thumb: { warmupFrames: 1 },
  files: ['index.tsx', 'renderer.ts', 'pipeline.ts', 'pointer-input.ts', 'fractal-math.ts', 'fractal.wgsl', 'bright-pass.wgsl', 'blur.wgsl', 'composite.wgsl'],
} as const satisfies ExampleMetaDefinition;
