import type { ExampleMetaDefinition } from '../../lib/example-meta';

export const meta = {
  slug: 'radiance-cascades',
  title: 'Radiance Cascades',
  description:
    'Draw light with the pointer and watch it bounce: a jump-flooded distance field feeds six radiance cascades — base 4, geometric intervals, linear RGBA16F — merged top-down with visibility alpha into 2D global illumination.',
  tags: ['lighting', 'hdr', 'raymarching', 'rendering', 'shader'],
  capabilities: [
    'webgpu', 'multi-pass', 'render-targets', 'textures', 'hdr',
    'pointer-input', 'controls', 'select-control', 'responsive-canvas', 'continuous-rendering',
  ],
  thumb: { warmupFrames: 1, dt: 1 / 60 },
  files: [
    'index.tsx', 'controls.tsx', 'types.ts', 'renderer.ts', 'simulation.ts', 'validation.ts',
    'pointer-input.ts', 'math.ts',
    'rc-directions.wgsl', 'rc-intervals.wgsl', 'rc-merge.wgsl', 'jfa-step.wgsl', 'sdf-sample.wgsl', 'scene-grid.wgsl',
    'paint-emitter.wgsl', 'jfa-init.wgsl', 'jfa-pass.wgsl', 'sdf-finalize.wgsl', 'radiance-cascade.wgsl', 'present.wgsl',
  ],
} as const satisfies ExampleMetaDefinition;
