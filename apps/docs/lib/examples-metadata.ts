import { exampleThumbs } from './example-thumbs.generated';
import type { ExampleMeta, ExampleMetaDefinition } from './example-meta';
import { exampleSlugs, type ExampleSlug } from './example-slugs';

import { meta as gradientMeta } from '../examples/gradient/meta';
import { meta as triangleLedFrontMeta } from '../examples/triangle-led-front/meta';
import { meta as antiAliasingMeta } from '../examples/anti-aliasing/meta';
import { meta as postProcessingMeta } from '../examples/post-processing/meta';
import { meta as blackHoleMeta } from '../examples/black-hole/meta';
import { meta as earthMeta } from '../examples/earth/meta';
import { meta as fluidMeta } from '../examples/fluid/meta';
import { meta as instancedRenderingMeta } from '../examples/instanced-rendering/meta';
import { meta as batchRenderingMeta } from '../examples/batch-rendering/meta';
import { meta as fftOceanMeta } from '../examples/fft-ocean/meta';
import { meta as raymarchedFractalMeta } from '../examples/raymarched-fractal/meta';
import { meta as environmentMapMeta } from '../examples/environment-map/meta';
import { meta as transmissionMeta } from '../examples/transmission/meta';
import { meta as radianceCascadesMeta } from '../examples/radiance-cascades/meta';
import { meta as nextjsFlareMeta } from '../examples/nextjs-flare/meta';

const rawMetadata = {
  gradient: gradientMeta,
  'triangle-led-front': triangleLedFrontMeta,
  'anti-aliasing': antiAliasingMeta,
  'post-processing': postProcessingMeta,
  'black-hole': blackHoleMeta,
  earth: earthMeta,
  fluid: fluidMeta,
  'instanced-rendering': instancedRenderingMeta,
  'batch-rendering': batchRenderingMeta,
  'fft-ocean': fftOceanMeta,
  'raymarched-fractal': raymarchedFractalMeta,
  'environment-map': environmentMapMeta,
  transmission: transmissionMeta,
  'radiance-cascades': radianceCascadesMeta,
  'nextjs-flare': nextjsFlareMeta,
} satisfies Record<ExampleSlug, ExampleMetaDefinition>;

function withThumbnails(meta: ExampleMetaDefinition): ExampleMeta {
  return {
    ...meta,
    thumbnail: exampleThumbs[meta.slug]?.card,
    hero: exampleThumbs[meta.slug]?.hero,
  };
}

export const exampleMetadataBySlug = {
  gradient: withThumbnails(rawMetadata.gradient),
  'triangle-led-front': withThumbnails(rawMetadata['triangle-led-front']),
  'anti-aliasing': withThumbnails(rawMetadata['anti-aliasing']),
  'post-processing': withThumbnails(rawMetadata['post-processing']),
  'black-hole': withThumbnails(rawMetadata['black-hole']),
  earth: withThumbnails(rawMetadata.earth),
  fluid: withThumbnails(rawMetadata.fluid),
  'instanced-rendering': withThumbnails(rawMetadata['instanced-rendering']),
  'batch-rendering': withThumbnails(rawMetadata['batch-rendering']),
  'fft-ocean': withThumbnails(rawMetadata['fft-ocean']),
  'raymarched-fractal': withThumbnails(rawMetadata['raymarched-fractal']),
  'environment-map': withThumbnails(rawMetadata['environment-map']),
  transmission: withThumbnails(rawMetadata.transmission),
  'radiance-cascades': withThumbnails(rawMetadata['radiance-cascades']),
  'nextjs-flare': withThumbnails(rawMetadata['nextjs-flare']),
} satisfies Record<ExampleSlug, ExampleMeta>;

export const examplesMetadata = exampleSlugs.map((slug) => exampleMetadataBySlug[slug]);

export function getExampleMetadata(slug: string): ExampleMeta | undefined {
  return exampleMetadataBySlug[slug as ExampleSlug];
}
