export const meta = {
  slug: 'fluid',
  title: 'Fluid Simulation',
  description: 'Compute-driven dye flow with ping-pong storage textures and a vgpu display pass.',
  thumb: { warmupFrames: 180, dt: 1 / 60, note: 'Rendered at a converged synthetic time for a stable poster.' },
  files: ['meta.ts', 'example.ts', 'compute.wgsl', 'display.wgsl'],
} as const;
