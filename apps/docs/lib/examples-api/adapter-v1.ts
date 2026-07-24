import type { ExampleByteGraph, ExampleGraphSource, UnhashedExampleRecord } from './byte-graph';
import { buildByteGraph } from './hashing';

/** Frozen shape exported by React ingestion after foundation commit 0c77a65. */
export interface CanonicalSourceExportRecord {
  readonly slug: string;
  readonly title: string;
  readonly description: string;
  readonly tags: readonly string[];
  readonly capabilities: readonly string[];
  readonly files: readonly {
    readonly path: string;
    readonly language: string;
    readonly content: string;
  }[];
}

/**
 * Adapts React's data-only generated export without sorting or transforming bytes.
 * This is the public artifact-generation adapter after the all-ten migration checkpoint.
 */
export function adaptCanonicalSourceExport(
  exported: Readonly<Record<string, CanonicalSourceExportRecord>>,
  source: ExampleGraphSource,
): ExampleByteGraph {
  const records: UnhashedExampleRecord[] = Object.entries(exported).map(([key, record]) => {
    if (key !== record.slug) throw new Error(`Canonical source key/slug mismatch: ${key}`);
    return {
      id: record.slug,
      metadata: {
        title: record.title,
        description: record.description,
        tags: record.tags,
        capabilities: record.capabilities,
      },
      files: record.files.map((file) => ({
        path: file.path,
        text: file.content,
        contentType: contentType(file.path),
      })),
    };
  });
  return buildByteGraph(records, source);
}

/** Direct seam retained for already-normalized records and isolated tests. */
export function adaptCanonicalExamples(
  records: readonly UnhashedExampleRecord[],
  source: ExampleGraphSource,
): ExampleByteGraph {
  return buildByteGraph(records, source);
}

function contentType(path: string): 'text/typescript' | 'text/wgsl' | 'text/plain' {
  if (path.endsWith('.ts') || path.endsWith('.tsx')) return 'text/typescript';
  if (path.endsWith('.wgsl')) return 'text/wgsl';
  return 'text/plain';
}
