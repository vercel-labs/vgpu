export const meta = {
  slug: 'raymarched-fractal',
  title: 'Raymarched fractal',
  description: 'A raymarched Sierpiński tetrahedron emerges from pure black under directional light and restrained HDR bloom, with drag-only orbit controls.',
  thumb: { warmupFrames: 1 },
  files: ['example.ts', 'controls.ts', 'fractal-math.ts', 'fractal.wgsl', 'bright-pass.wgsl', 'blur.wgsl', 'composite.wgsl'],
} as const;
