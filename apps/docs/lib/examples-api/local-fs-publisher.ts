import { link, rename, rm, writeFile } from 'node:fs/promises';
import type { GeneratedArtifact } from './artifact-generator';
import type { ArtifactPublisher, PublishedObjectHead } from './publisher';
import { sha256 } from './hashing';
import { assertSafeMutableLeaf, readSafeLocalFile, withSafeLocalParent } from './safe-local-path';

export class LocalFsPublisher implements ArtifactPublisher {
  constructor(readonly rootDirectory: string) {}

  async putImmutable(artifact: GeneratedArtifact): Promise<void> {
    await withSafeLocalParent(this.rootDirectory, artifact.key, true, async (destination) => {
      const metadataDestination = `${destination}.meta.json`;
      const token = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const temporary = `${destination}.tmp-${token}`;
      const temporaryMeta = `${temporary}.meta.json`;
      try {
        await writeFile(temporary, artifact.bytes, { flag: 'wx', mode: 0o600 });
        await writeFile(temporaryMeta, this.metadata(artifact), { flag: 'wx', mode: 0o600 });
        // Descriptor-anchored paths keep every operation in the opened parent,
        // even if its pathname is concurrently replaced with a symlink.
        await link(temporary, destination);
        try {
          await link(temporaryMeta, metadataDestination);
        } catch (error) {
          await rm(destination, { force: true });
          throw error;
        }
      } finally {
        await rm(temporary, { force: true });
        await rm(temporaryMeta, { force: true });
      }
    });
  }

  async advancePointer(artifact: GeneratedArtifact): Promise<void> {
    await withSafeLocalParent(this.rootDirectory, artifact.key, true, async (destination) => {
      const metadataDestination = `${destination}.meta.json`;
      const token = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const temporary = `${destination}.tmp-${token}`;
      const temporaryMeta = `${temporary}.meta.json`;
      try {
        await writeFile(temporary, artifact.bytes, { flag: 'wx', mode: 0o600 });
        await writeFile(temporaryMeta, this.metadata(artifact), { flag: 'wx', mode: 0o600 });
        await assertSafeMutableLeaf(metadataDestination);
        await rename(temporaryMeta, metadataDestination);
        await assertSafeMutableLeaf(destination);
        await rename(temporary, destination);
      } finally {
        await rm(temporary, { force: true });
        await rm(temporaryMeta, { force: true });
      }
    });
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    return readSafeLocalFile(this.rootDirectory, key);
  }

  async head(key: string): Promise<PublishedObjectHead | undefined> {
    const [bytes, metadataBytes] = await Promise.all([
      readSafeLocalFile(this.rootDirectory, key),
      readSafeLocalFile(this.rootDirectory, `${key}.meta.json`),
    ]);
    if (!bytes || !metadataBytes) return undefined;
    const metadata = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(metadataBytes)) as { contentType: string };
    return { size: bytes.byteLength, sha256: sha256(bytes), contentType: metadata.contentType };
  }

  private metadata(artifact: GeneratedArtifact): string {
    return `${JSON.stringify({ contentType: artifact.contentType, sha256: artifact.sha256, size: artifact.bytes.byteLength })}\n`;
  }
}
