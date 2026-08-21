import type { ExampleMetaDefinition } from '../../lib/example-meta';

export const meta = {
  slug: 'agent-radiance-cascades',
  title: 'Agent Radiance Cascades',
  description:
    'The static ten-dot Agent mark becomes a selectable loading field with capture-quality controls: every gray-to-white dot is both an HDR emitter and an occluder, feeding a jump-flooded distance field and six top-down radiance cascades.',
  tags: ['lighting', 'hdr', 'raymarching', 'rendering', 'shader'],
  capabilities: [
    'webgpu', 'multi-pass', 'render-targets', 'textures', 'hdr',
    'controls', 'select-control', 'responsive-canvas', 'continuous-rendering',
  ],
  thumb: { warmupFrames: 1, time: 1.5, dt: 1 / 60 },
  files: [
    'index.tsx', 'controls.tsx', 'types.ts', 'renderer.ts', 'scene-size.ts', 'simulation.ts', 'validation.ts', 'math.ts',
    'agent-dots.wgsl', 'jfa-init.wgsl', 'jfa-pass.wgsl', 'jfa-step.wgsl', 'sdf-finalize.wgsl',
    'sdf-sample.wgsl', 'radiance-cascade.wgsl', 'rc-directions.wgsl', 'rc-intervals.wgsl',
    'rc-merge.wgsl', 'scene-grid.wgsl', 'present.wgsl',
  ],
} as const satisfies ExampleMetaDefinition;
