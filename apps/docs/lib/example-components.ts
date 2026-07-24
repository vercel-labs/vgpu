import type { ComponentType } from 'react';
import type { ExampleSlug } from './example-slugs';

export interface ExampleComponentModule {
  readonly Example: ComponentType;
}

export type ExampleComponentLoader = () => Promise<ExampleComponentModule>;

export const exampleComponentLoaders = {
  gradient: () => import('../examples/gradient/index'),
  'triangle-led-front': () => import('../examples/triangle-led-front/index'),
  'anti-aliasing': () => import('../examples/anti-aliasing/index'),
  'post-processing': () => import('../examples/post-processing/index'),
  'black-hole': () => import('../examples/black-hole/index'),
  fluid: () => import('../examples/fluid/index'),
  'instanced-rendering': () => import('../examples/instanced-rendering/index'),
  'batch-rendering': () => import('../examples/batch-rendering/index'),
  'fft-ocean': () => import('../examples/fft-ocean/index'),
  'raymarched-fractal': () => import('../examples/raymarched-fractal/index'),
} satisfies Record<ExampleSlug, ExampleComponentLoader>;

export function getExampleComponentLoader(slug: ExampleSlug): ExampleComponentLoader {
  return exampleComponentLoaders[slug];
}
