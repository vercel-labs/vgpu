import type { ExampleMetaDefinition } from '../../lib/example-meta';

export const meta = {
  slug: 'earth',
  title: 'Earth',
  description:
    'A procedural planet with GPU-baked albedo, night lights and clouds, a lit atmosphere, and an HDR bloom chain tuned so only the sun glows.',
  tags: ['lighting', 'hdr', 'bloom', 'rendering'],
  capabilities: ['webgpu', 'pointer-orbit', 'controls', 'multi-pass', 'continuous-rendering', 'responsive-canvas', 'textures'],
  thumb: { warmupFrames: 2, dt: 1 / 60, time: 0 },
  files: [
    'index.tsx', 'controls.tsx', 'types.ts', 'renderer.ts', 'scene.ts', 'planet.ts',
    'planet-common.wgsl', 'bake-surface.wgsl', 'bake-clouds.wgsl',
    'sky.wgsl', 'earth.wgsl', 'atmosphere.wgsl',
    'overlay.wgsl', 'bright-pass.wgsl', 'blur.wgsl', 'composite.wgsl',
  ],
} as const satisfies ExampleMetaDefinition;
