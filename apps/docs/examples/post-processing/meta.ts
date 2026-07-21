export const meta = {
  slug: 'post-processing',
  title: 'Post-Processing',
  description: 'A bloom → chromatic-aberration effect chain over crisp animated geometry, with each pass toggleable.',
  thumb: { warmupFrames: 60, dt: 1 / 60, time: 2.0 },
  files: ['example.ts', 'controls.ts', 'scene.wgsl', 'threshold.wgsl', 'blur.wgsl', 'grade.wgsl'],
} as const;
