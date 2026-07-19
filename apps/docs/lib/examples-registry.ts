import { exampleSources, type ExampleSourceFile } from './examples-source.generated';
import { exampleThumbs } from './example-thumbs.generated';

import { meta as gradientMeta } from '../examples/gradient/meta';
import { meta as triangleLedGodRaysMeta } from '../examples/triangle-led-god-rays/meta';

export interface ExampleThumbOptions {
  readonly warmupFrames?: number;
  readonly time?: number;
  readonly dt?: number;
  readonly headless?: boolean;
  readonly note?: string;
  readonly fragmentFile?: string;
}

export interface ExampleMeta {
  readonly slug: string;
  readonly title: string;
  readonly description: string;
  readonly thumbnail?: string;
  readonly hero?: string;
  readonly thumb?: ExampleThumbOptions;
  readonly files?: readonly string[];
}

export interface ExampleRecord {
  readonly meta: ExampleMeta;
  readonly sources: readonly ExampleSourceFile[];
}

const rawMetas = [
  gradientMeta,
  triangleLedGodRaysMeta,
] as const satisfies readonly ExampleMeta[];

const metas = rawMetas.map((meta) => ({
  ...meta,
  thumbnail: exampleThumbs[meta.slug]?.card,
  hero: exampleThumbs[meta.slug]?.hero,
})) satisfies readonly ExampleMeta[];

export const examples = metas.map((meta) => ({
  meta,
  sources: exampleSources[meta.slug] ?? [],
})) satisfies readonly ExampleRecord[];

export function getExample(slug: string): ExampleRecord | undefined {
  return examples.find((example) => example.meta.slug === slug);
}
