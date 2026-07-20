export const meta = {
  slug: 'instanced-rendering',
  title: 'Instanced Rendering',
  description: 'One cube mesh + one instance stream, with 125,000 independently animated cubes.',
  thumb: { warmupFrames: 3, dt: 1 / 60, time: 2.4 },
  files: ['example.ts', 'scene.wgsl', 'blit.wgsl'],
} as const;
