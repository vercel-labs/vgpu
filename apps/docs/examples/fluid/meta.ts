export const meta = {
  slug: 'fluid',
  title: 'Interactive Fluid',
  description: 'A compact pressure-projected fluid solver with velocity advection, colorful dye, and pointer or touch stirring.',
  thumb: { warmupFrames: 120, dt: 1 / 60 },
  files: ['example.ts', 'simulation.ts', 'controls.ts', 'math.ts', 'fluid-common.wgsl', 'advect-velocity.wgsl', 'curl.wgsl', 'vorticity.wgsl', 'divergence.wgsl', 'pressure.wgsl', 'project.wgsl', 'advect-dye.wgsl', 'display.wgsl'],
} as const;
