/** Frozen, framework-neutral input consumed by the examples API generator. */
export const EXAMPLE_BYTE_GRAPH_VERSION = 1 as const;

export interface ExampleGraphSource {
  readonly repository: string;
  readonly gitCommit: string;
}

export interface ExampleMetadata {
  readonly title: string;
  readonly description: string;
  readonly tags: readonly string[];
  readonly capabilities: readonly string[];
}

export interface ExampleByteFile {
  readonly path: string;
  /** Exact LF-normalized text transported to CodeViewer and the public API. */
  readonly text: string;
  readonly contentType: 'text/typescript' | 'text/wgsl' | 'text/plain';
  readonly size: number;
  readonly sha256: string;
}

export interface ExampleByteRecord {
  readonly id: string;
  readonly metadata: ExampleMetadata;
  readonly files: readonly ExampleByteFile[];
  readonly aggregateSha256: string;
}

export interface ExampleByteGraph {
  readonly graphVersion: typeof EXAMPLE_BYTE_GRAPH_VERSION;
  readonly source: ExampleGraphSource;
  /** SHA-256 of the canonical graph revision serialization. */
  readonly revision: string;
  readonly examples: readonly ExampleByteRecord[];
}

export type UnhashedExampleFile = Pick<ExampleByteFile, 'path' | 'text' | 'contentType'>;
export interface UnhashedExampleRecord {
  readonly id: string;
  readonly metadata: ExampleMetadata;
  readonly files: readonly UnhashedExampleFile[];
}
