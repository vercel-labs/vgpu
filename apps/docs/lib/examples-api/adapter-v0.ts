import type { ExampleByteGraph, ExampleGraphSource, ExampleMetadata, UnhashedExampleRecord } from './byte-graph';
import { buildByteGraph } from './hashing';

export interface LegacyMeta {
  readonly slug: string;
  readonly title: string;
  readonly description: string;
}

export interface LegacySourceFile {
  readonly name: string;
  readonly code: string;
}

// Historical v0 metadata remains available for compatibility tests and retained
// artifact archaeology. Public generation uses adapter v1.
const legacyVocabulary: Readonly<Record<string, Pick<ExampleMetadata, 'tags' | 'capabilities'>>> = {
  gradient: { tags: ['gradient', 'rendering'], capabilities: [] },
  'triangle-led-front': { tags: ['animation', 'rendering'], capabilities: ['controls'] },
  'anti-aliasing': { tags: ['anti-aliasing', 'rendering'], capabilities: ['controls', 'multi-pass', 'textures'] },
  'black-hole': { tags: ['raymarching', 'hdr', 'bloom'], capabilities: ['hdr', 'multi-pass', 'textures'] },
  fluid: { tags: ['fluid', 'compute', 'animation'], capabilities: ['compute', 'controls', 'storage-buffers'] },
  'instanced-rendering': { tags: ['instancing', 'rendering'], capabilities: ['instancing'] },
  'batch-rendering': { tags: ['batching', 'rendering'], capabilities: ['render-bundles'] },
  'fft-ocean': { tags: ['fft', 'ocean', 'particles', 'hdr', 'bloom'], capabilities: ['compute', 'hdr', 'multi-pass', 'storage-buffers'] },
  'raymarched-fractal': {
    tags: ['raymarching', 'raymarch', 'fractal', 'sierpinski', 'hdr', 'bloom'],
    capabilities: ['controls', 'hdr', 'multi-pass'],
  },
};

export function adaptLegacySources(
  sources: Readonly<Record<string, readonly LegacySourceFile[]>>,
  metas: readonly LegacyMeta[],
  source: ExampleGraphSource,
): ExampleByteGraph {
  const records: UnhashedExampleRecord[] = metas.map((meta) => {
    const vocabulary = legacyVocabulary[meta.slug];
    if (!vocabulary) throw new Error(`Missing controlled vocabulary for ${meta.slug}`);
    const sourceFiles = sources[meta.slug];
    if (!sourceFiles) throw new Error(`Missing generated source for ${meta.slug}`);
    return {
      id: meta.slug,
      metadata: { title: meta.title, description: meta.description, ...vocabulary },
      files: sourceFiles.map((file) => ({
        path: file.name,
        text: file.code,
        contentType: contentType(file.name),
      })),
    };
  });
  return buildByteGraph(records, source);
}

function contentType(path: string): 'text/typescript' | 'text/wgsl' | 'text/plain' {
  if (path.endsWith('.ts') || path.endsWith('.tsx')) return 'text/typescript';
  if (path.endsWith('.wgsl')) return 'text/wgsl';
  return 'text/plain';
}
