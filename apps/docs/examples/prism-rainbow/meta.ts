import type { ExampleMetaDefinition } from '../../lib/example-meta';

export const meta = {
  slug: 'prism-rainbow',
  title: 'Prism Rainbow',
  description:
    'A spectral path tracer solves one plane of a three-dimensional room: every fragment of the wall fires 16 rays at random points across the glass, refracts each one, and keeps the ones that come out aimed at the lamp. The accumulated rainbow becomes the wall’s texture, and the triangle it was traced through stands in front of it as a transmissive glass prism.',
  tags: ['lighting', 'raycasting', 'rendering', 'frosted-glass', 'shader'],
  capabilities: [
    'webgpu',
    'fragment-shader',
    'multi-pass',
    'render-targets',
    'textures',
    'continuous-rendering',
    'pointer-input',
    'pointer-orbit',
    'controls',
    'select-control',
    'responsive-canvas',
  ],
  // The picture is a function of how many frames were averaged and nothing else
  // — no clock is read anywhere, and the camera rests centered — so a fixed frame
  // count is reproducible.
  thumb: {
    warmupFrames: 600,
    note: 'Six hundred accumulated frames of the real trace, wall and glass passes; the estimate is a function of the frame count alone, so this render is deterministic.',
  },
  files: [
    'index.tsx',
    'controls.tsx',
    'renderer.ts',
    'scene.ts',
    'camera.ts',
    'prism-mesh.ts',
    'types.ts',
    'optics.ts',
    'validation.ts',
    'optics.wgsl',
    'scene.wgsl',
    'trace.wgsl',
    'wall.wgsl',
    'glass.wgsl',
    'environment.wgsl',
    'present.wgsl',
    'probe.wgsl',
  ],
} as const satisfies ExampleMetaDefinition;
