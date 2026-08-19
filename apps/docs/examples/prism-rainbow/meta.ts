import type { ExampleMetaDefinition } from '../../lib/example-meta';

export const meta = {
  slug: 'prism-rainbow',
  title: 'Prism Rainbow',
  description:
    'A finite collimated beam is traced analytically through a prism with Snell refraction, Fresnel transmission and total internal reflection. Adjacent wavelength vertices become continuous additive mesh sheets, with spectral color computed per vertex and smoothly interpolated by the fragment stage. The result is deterministic in one frame and the refracted beam keeps its physical width.',
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
  thumb: {
    warmupFrames: 1,
    note: 'One deterministic render of the analytic ray bundle, continuous spectral mesh, wall and glass passes.',
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
    'light-mesh.ts',
    'validation.ts',
    'scene.wgsl',
    'light.wgsl',
    'wall.wgsl',
    'glass.wgsl',
    'environment.wgsl',
    'present.wgsl',
  ],
} as const satisfies ExampleMetaDefinition;
