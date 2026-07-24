export const exampleSlugs = [
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

export type ExampleSlug = (typeof exampleSlugs)[number];

const exampleSlugSet: ReadonlySet<string> = new Set(exampleSlugs);

export function isExampleSlug(slug: string): slug is ExampleSlug {
  return exampleSlugSet.has(slug);
}
