import type { GeneratedArtifact, GeneratedArtifactSet } from './artifact-generator';
import { sha256 } from './hashing';

export interface PublishedObjectHead {
  readonly size: number;
  readonly sha256: string;
  readonly contentType: string;
}

export interface ArtifactPublisher {
  putImmutable(artifact: GeneratedArtifact): Promise<void>;
  get(key: string): Promise<Uint8Array | undefined>;
  head(key: string): Promise<PublishedObjectHead | undefined>;
  /** Atomic mutable write. The latest pointer is always advanced last. */
  advancePointer(artifact: GeneratedArtifact): Promise<void>;
}

export async function publishArtifactSet(
  publisher: ArtifactPublisher,
  set: GeneratedArtifactSet,
  options: { beforeLatest?: (set: GeneratedArtifactSet) => Promise<void> } = {},
): Promise<void> {
  const immutable = set.artifacts.filter((artifact) => artifact.immutable);
  for (const artifact of immutable) {
    let writeError: unknown;
    try {
      await publisher.putImmutable(artifact);
    } catch (error) {
      // The store is create-only, so a retry may legitimately encounter an already retained
      // object. That is acceptable only when the fresh read below proves it is byte-identical.
      // Any other failure is real, so keep it and report it as the cause rather than letting the
      // verification surface a bare "mismatch" that hides why the write actually failed.
      writeError = error;
    }
    try {
      await verifyPublishedObject(publisher, artifact);
    } catch (verifyError) {
      if (writeError === undefined) throw verifyError;
      const detail = verifyError instanceof Error ? verifyError.message : String(verifyError);
      throw new Error(`Immutable write failed for ${artifact.key}: ${detail}`, { cause: writeError });
    }
  }
  const discovery = set.artifacts.find((artifact) => artifact.key === set.discoveryKey)!;
  const latest = set.artifacts.find((artifact) => artifact.key === set.latestKey)!;
  await publisher.advancePointer(discovery);
  await verifyPublishedObject(publisher, discovery);
  await options.beforeLatest?.(set);
  // Latest is the publication transaction boundary. A fresh read must prove
  // the mutable write retained the exact pointer before success is reported.
  await publisher.advancePointer(latest);
  await verifyPublishedObject(publisher, latest);
}

export async function verifyPublishedObject(publisher: ArtifactPublisher, artifact: GeneratedArtifact): Promise<void> {
  const head = await publisher.head(artifact.key);
  if (!head || head.size !== artifact.bytes.byteLength || head.sha256 !== artifact.sha256 || head.contentType !== artifact.contentType) {
    throw new Error(`Published object head mismatch: ${artifact.key}`);
  }
  const bytes = await publisher.get(artifact.key);
  if (!bytes || bytes.byteLength !== artifact.bytes.byteLength || sha256(bytes) !== artifact.sha256) {
    throw new Error(`Published object byte mismatch: ${artifact.key}`);
  }
}
