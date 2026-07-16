export const meta = {
  slug: 'triangle-particles',
  title: 'Triangle Particles',
  description: 'A compute-updated particle field emitted from a glowing triangle.',
  thumb: { warmupFrames: 90, dt: 1 / 60, note: 'Compute warm-up with a synthetic fixed-step clock.' },
  files: ['meta.ts', 'example.ts', 'compute.wgsl', 'render.wgsl'],
} as const;
