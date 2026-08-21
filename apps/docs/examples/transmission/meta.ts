import type { ExampleMetaDefinition } from '../../lib/example-meta';

export const meta = {
  slug: 'transmission',
  title: 'Transmission',
  description:
    'A glass cube refracts the scene behind it in screen space: the frame is rendered, blurred into a pyramid, and read back through Snell refraction, chromatic dispersion and a Fresnel-weighted environment reflection.',
  tags: ['lighting', 'hdr', 'rendering', 'shader'],
  capabilities: [
    'webgpu', 'pointer-orbit', 'controls', 'checkbox-controls', 'select-control',
    'multi-pass', 'render-targets', 'continuous-rendering', 'responsive-canvas', 'textures', 'hdr',
  ],
  thumb: { warmupFrames: 3, dt: 1 / 60, time: 2.1 },
  files: [
    'index.tsx', 'controls.tsx', 'types.ts', 'renderer.ts', 'scene.ts', 'camera.ts', 'pointer-input.ts',
    'sky.wgsl', 'blur.wgsl', 'env-common.wgsl', 'scene-background.wgsl', 'floor.wgsl',
    'backface-normal.wgsl', 'backface.wgsl', 'refraction.wgsl', 'dispersion.wgsl', 'cone.wgsl',
    'fresnel.wgsl', 'lod-selection.wgsl', 'glass.wgsl', 'present.wgsl',
  ],
} as const satisfies ExampleMetaDefinition;
