export const meta = {
  slug: 'fluid',
  title: 'Fluid Simulation',
  description: 'Compute shader paints a dye field into a storage buffer each frame; a display pass reads it back to the screen.',
  thumb: { warmupFrames: 180, dt: 1 / 60, note: 'Rendered at a converged synthetic time for a stable poster.' },
  files: ['example.ts', 'compute.wgsl', 'display.wgsl'],
} as const;
