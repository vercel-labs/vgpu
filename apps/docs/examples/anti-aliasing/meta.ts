export const meta = {
  slug: 'anti-aliasing',
  title: 'Anti-Aliasing',
  description: 'One high-contrast scene through Off, MSAA 4×, SSAA 2×, and FXAA — pick a mode and watch the edges.',
  thumb: { warmupFrames: 60, dt: 1 / 60, time: 1.2 },
  files: ['example.ts', 'controls.ts', 'scene.wgsl', 'resolve.wgsl', 'fxaa.wgsl'],
} as const;
