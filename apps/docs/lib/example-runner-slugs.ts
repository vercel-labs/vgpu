export const exampleRunnerSlugs = [
  'gradient',
  'triangle-led-front',
  'anti-aliasing',
  'post-processing',
  'black-hole',
  'fluid',
  'instanced-rendering',
  'batch-rendering',
] as const;

export type ExampleRunnerSlug = (typeof exampleRunnerSlugs)[number];
