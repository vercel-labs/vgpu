export const exampleRunnerSlugs = [
  'gradient',
  'triangle-led-front',
  'anti-aliasing',
  'post-processing',
  'fluid',
] as const;

export type ExampleRunnerSlug = (typeof exampleRunnerSlugs)[number];
