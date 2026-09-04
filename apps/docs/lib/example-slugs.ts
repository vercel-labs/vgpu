export const exampleSlugs = [
  'gradient',
  'triangle-led-front',
  'anti-aliasing',
  'black-hole',
  'optimized-black-hole',
  'earth',
  'fluid',
  'instanced-rendering',
  'batch-rendering',
  'fft-ocean',
  'fft-ocean-surface',
  'raymarched-fractal',
  'glass-fractal',
  'environment-map',
  'transmission',
  'clipping',
  'radiance-cascades',
  'agent-radiance-cascades',
  'nextjs-flare',
  'depth-estimation',
  'mnist-classifier',
  'air-painting',
  'tsl-exports',
  'three-tsl',
  'particle-orbit',
  'adaptive-quality',
] as const;

export type ExampleSlug = (typeof exampleSlugs)[number];

const exampleSlugSet: ReadonlySet<string> = new Set(exampleSlugs);

export function isExampleSlug(slug: string): slug is ExampleSlug {
  return exampleSlugSet.has(slug);
}
