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
  'black-hole': () => import('../examples/black-hole/index'),
  'optimized-black-hole': () => import('../examples/optimized-black-hole/index'),
  earth: () => import('../examples/earth/index'),
  fluid: () => import('../examples/fluid/index'),
  'instanced-rendering': () => import('../examples/instanced-rendering/index'),
  'batch-rendering': () => import('../examples/batch-rendering/index'),
  'fft-ocean': () => import('../examples/fft-ocean/index'),
  'fft-ocean-surface': () => import('../examples/fft-ocean-surface/index'),
  'raymarched-fractal': () => import('../examples/raymarched-fractal/index'),
  'glass-fractal': () => import('../examples/glass-fractal/index'),
  'environment-map': () => import('../examples/environment-map/index'),
  transmission: () => import('../examples/transmission/index'),
  clipping: () => import('../examples/clipping/index'),
  'radiance-cascades': () => import('../examples/radiance-cascades/index'),
  'agent-radiance-cascades': () => import('../examples/agent-radiance-cascades/index'),
  'nextjs-flare': () => import('../examples/nextjs-flare/index'),
  'depth-estimation': () => import('../examples/depth-estimation/index'),
  'mnist-classifier': () => import('../examples/mnist-classifier/index'),
  'air-painting': () => import('../examples/air-painting/index'),
  'tsl-exports': () => import('../examples/tsl-exports/index'),
  'three-tsl': () => import('../examples/three-tsl/index'),
  'particle-orbit': () => import('../examples/particle-orbit/index'),
  'adaptive-quality': () => import('../examples/adaptive-quality/index'),
  'spiral-galaxy': () => import('../examples/spiral-galaxy/index'),
} satisfies Record<ExampleSlug, ExampleComponentLoader>;

export function getExampleComponentLoader(slug: ExampleSlug): ExampleComponentLoader {
  return exampleComponentLoaders[slug];
}
