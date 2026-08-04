import { get, put } from '@vercel/blob';
import type { GeneratedArtifact } from './artifact-generator';
import type { ArtifactPublisher, PublishedObjectHead } from './publisher';
import { sha256 } from './hashing';

/** Deployment-only durable publisher. Revision writes are create-only; pointers overwrite. */
export class VercelBlobPublisher implements ArtifactPublisher {
  constructor(private readonly token = process.env.VGPU_EXAMPLES_VERCEL_BLOB_READ_WRITE_TOKEN) {
    if (!token) throw new Error('Missing VGPU_EXAMPLES_VERCEL_BLOB_READ_WRITE_TOKEN');
  }

  async putImmutable(artifact: GeneratedArtifact): Promise<void> {
    await put(artifact.key, Buffer.from(artifact.bytes), {
      access: 'public', addRandomSuffix: false, allowOverwrite: false,
      contentType: artifact.contentType, cacheControlMaxAge: 31_536_000, token: this.token,
    });
  }

  async advancePointer(artifact: GeneratedArtifact): Promise<void> {
    await put(artifact.key, Buffer.from(artifact.bytes), {
      access: 'public', addRandomSuffix: false, allowOverwrite: true,
      contentType: artifact.contentType, cacheControlMaxAge: 60, token: this.token,
    });
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    const result = await get(key, { access: 'public', useCache: false, token: this.token });
    if (!result || !result.stream) return undefined;
    const reader = result.stream.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  }

  async head(key: string): Promise<PublishedObjectHead | undefined> {
    const result = await get(key, { access: 'public', useCache: false, token: this.token });
    if (!result || !result.stream) return undefined;
    const reader = result.stream.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value); size += value.byteLength;
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return { size, sha256: sha256(bytes), contentType: result.blob.contentType ?? 'application/octet-stream' };
  }
}
