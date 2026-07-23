export const exampleRunnerSlugs = [
  'gradient',
  'triangle-led-front',
  'anti-aliasing',
  'post-processing',
  'black-hole',
  'fluid',
  'instanced-rendering',
  'batch-rendering',
  'fft-ocean',
  'raymarched-fractal',
] as const;

export type ExampleRunnerSlug = (typeof exampleRunnerSlugs)[number];
