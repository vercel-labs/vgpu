import { exampleSources, type ExampleSourceFile } from './examples-source.generated';

import { meta as gradientMeta } from '../examples/gradient/meta';
import { meta as waveMeta } from '../examples/wave/meta';
import { meta as colorCycleMeta } from '../examples/color-cycle/meta';
import { meta as raymarchingMeta } from '../examples/raymarching/meta';
import { meta as noiseMeta } from '../examples/noise/meta';
import { meta as metaballsMeta } from '../examples/metaballs/meta';
import { meta as fractalMeta } from '../examples/fractal/meta';
import { meta as alienPlanetMeta } from '../examples/alien-planet/meta';
import { meta as fluidMeta } from '../examples/fluid/meta';
import { meta as triangleParticlesMeta } from '../examples/triangle-particles/meta';

export interface ExampleMeta {
  readonly slug: string;
  readonly title: string;
  readonly description: string;
  readonly thumbnail?: string;
  readonly files?: readonly string[];
}

export interface ExampleRecord {
  readonly meta: ExampleMeta;
  readonly sources: readonly ExampleSourceFile[];
}

const metas = [
  gradientMeta,
  waveMeta,
  colorCycleMeta,
  raymarchingMeta,
  noiseMeta,
  metaballsMeta,
  fractalMeta,
  alienPlanetMeta,
  fluidMeta,
  triangleParticlesMeta,
] as const satisfies readonly ExampleMeta[];

export const examples = metas.map((meta) => ({
  meta,
  sources: exampleSources[meta.slug] ?? [],
})) satisfies readonly ExampleRecord[];

export function getExample(slug: string): ExampleRecord | undefined {
  return examples.find((example) => example.meta.slug === slug);
}
