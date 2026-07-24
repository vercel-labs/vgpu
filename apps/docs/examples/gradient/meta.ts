import type { ExampleMetaDefinition } from '../../lib/example-meta';

export const meta = {
  slug: 'gradient',
  title: 'Simple Gradient',
  description: 'Map screen coordinates to color with a tiny fullscreen fragment shader.',
  tags: ['gradient', 'animation', 'shader'],
  capabilities: ['webgpu', 'fragment-shader', 'continuous-rendering', 'responsive-canvas'],
  thumb: { time: Math.PI / 4 },
  files: ['index.tsx', 'renderer.ts', 'shader.wgsl'],
} as const satisfies ExampleMetaDefinition;
