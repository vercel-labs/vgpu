/** Frozen, framework-neutral input consumed by the examples API generator. */
export const EXAMPLE_BYTE_GRAPH_VERSION = 1 as const;

export interface ExampleGraphSource {
  readonly repository: string;
  /**
   * Identity of the canonical source snapshot, `sha256:<hex>` of the exact bytes of
   * `apps/docs/lib/examples-source.generated.ts` (see `sourceSnapshotIdentity`).
   *
   * The key name is fixed by the frozen `vgpu-examples/v1` index schema, but the value is a
   * **content digest, not a commit SHA**: do not build `…/commit/<value>` URLs from it. Deriving it
   * from content keeps artifacts byte-identical for content-identical trees regardless of git
   * history or merge strategy (squash, rebase, synthetic merge refs).
   */
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
