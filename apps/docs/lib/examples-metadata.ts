import { exampleThumbs } from './example-thumbs.generated';
import type { ExampleMeta, ExampleMetaDefinition } from './example-meta';
import { exampleSlugs, type ExampleSlug } from './example-slugs';

import { meta as gradientMeta } from '../examples/gradient/meta';
import { meta as triangleLedFrontMeta } from '../examples/triangle-led-front/meta';
import { meta as antiAliasingMeta } from '../examples/anti-aliasing/meta';
import { meta as blackHoleMeta } from '../examples/black-hole/meta';
import { meta as optimizedBlackHoleMeta } from '../examples/optimized-black-hole/meta';
import { meta as earthMeta } from '../examples/earth/meta';
import { meta as fluidMeta } from '../examples/fluid/meta';
import { meta as instancedRenderingMeta } from '../examples/instanced-rendering/meta';
import { meta as batchRenderingMeta } from '../examples/batch-rendering/meta';
import { meta as fftOceanMeta } from '../examples/fft-ocean/meta';
import { meta as fftOceanSurfaceMeta } from '../examples/fft-ocean-surface/meta';
import { meta as raymarchedFractalMeta } from '../examples/raymarched-fractal/meta';
import { meta as glassFractalMeta } from '../examples/glass-fractal/meta';
import { meta as environmentMapMeta } from '../examples/environment-map/meta';
import { meta as transmissionMeta } from '../examples/transmission/meta';
import { meta as clippingMeta } from '../examples/clipping/meta';
import { meta as matcapMeta } from '../examples/matcap/meta';
import { meta as radianceCascadesMeta } from '../examples/radiance-cascades/meta';
import { meta as agentRadianceCascadesMeta } from '../examples/agent-radiance-cascades/meta';
import { meta as nextjsFlareMeta } from '../examples/nextjs-flare/meta';
import { meta as depthEstimationMeta } from '../examples/depth-estimation/meta';
import { meta as mnistClassifierMeta } from '../examples/mnist-classifier/meta';
import { meta as airPaintingMeta } from '../examples/air-painting/meta';

const rawMetadata = {
  gradient: gradientMeta,
  'triangle-led-front': triangleLedFrontMeta,
  'anti-aliasing': antiAliasingMeta,
  'black-hole': blackHoleMeta,
  'optimized-black-hole': optimizedBlackHoleMeta,
  earth: earthMeta,
  fluid: fluidMeta,
  'instanced-rendering': instancedRenderingMeta,
  'batch-rendering': batchRenderingMeta,
  'fft-ocean': fftOceanMeta,
  'fft-ocean-surface': fftOceanSurfaceMeta,
  'raymarched-fractal': raymarchedFractalMeta,
  'glass-fractal': glassFractalMeta,
  'environment-map': environmentMapMeta,
  transmission: transmissionMeta,
  clipping: clippingMeta,
  matcap: matcapMeta,
  'radiance-cascades': radianceCascadesMeta,
  'agent-radiance-cascades': agentRadianceCascadesMeta,
  'nextjs-flare': nextjsFlareMeta,
  'depth-estimation': depthEstimationMeta,
  'mnist-classifier': mnistClassifierMeta,
  'air-painting': airPaintingMeta,
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
  'black-hole': withThumbnails(rawMetadata['black-hole']),
  'optimized-black-hole': withThumbnails(rawMetadata['optimized-black-hole']),
  earth: withThumbnails(rawMetadata.earth),
  fluid: withThumbnails(rawMetadata.fluid),
  'instanced-rendering': withThumbnails(rawMetadata['instanced-rendering']),
  'batch-rendering': withThumbnails(rawMetadata['batch-rendering']),
  'fft-ocean': withThumbnails(rawMetadata['fft-ocean']),
  'fft-ocean-surface': withThumbnails(rawMetadata['fft-ocean-surface']),
  'raymarched-fractal': withThumbnails(rawMetadata['raymarched-fractal']),
  'glass-fractal': withThumbnails(rawMetadata['glass-fractal']),
  'environment-map': withThumbnails(rawMetadata['environment-map']),
  transmission: withThumbnails(rawMetadata.transmission),
  clipping: withThumbnails(rawMetadata.clipping),
  matcap: withThumbnails(rawMetadata.matcap),
  'radiance-cascades': withThumbnails(rawMetadata['radiance-cascades']),
  'agent-radiance-cascades': withThumbnails(rawMetadata['agent-radiance-cascades']),
  'nextjs-flare': withThumbnails(rawMetadata['nextjs-flare']),
  'depth-estimation': withThumbnails(rawMetadata['depth-estimation']),
  'mnist-classifier': withThumbnails(rawMetadata['mnist-classifier']),
  'air-painting': withThumbnails(rawMetadata['air-painting']),
} satisfies Record<ExampleSlug, ExampleMeta>;

export const examplesMetadata = exampleSlugs.map((slug) => exampleMetadataBySlug[slug]);

export function getExampleMetadata(slug: string): ExampleMeta | undefined {
  return exampleMetadataBySlug[slug as ExampleSlug];
}
