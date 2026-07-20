export const meta = {
  slug: 'fluid',
  title: 'Interactive Fluid',
  description: 'A pressure-projected stable-fluid solver stirred by pointer input, with 8,192 passive tracers updated in compute and drawn as mesh instances.',
  thumb: { warmupFrames: 120, dt: 1 / 60 },
  files: ['example.ts', 'controls.ts', 'math.ts', 'fluid-common.wgsl', 'advect-velocity.wgsl', 'divergence.wgsl', 'pressure.wgsl', 'project.wgsl', 'advect-dye.wgsl', 'update-particles.wgsl', 'display.wgsl', 'particles.wgsl'],
} as const;
