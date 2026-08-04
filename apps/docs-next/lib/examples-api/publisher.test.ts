import { describe, expect, it } from 'vitest';
import type { GeneratedArtifact, GeneratedArtifactSet } from './artifact-generator';
import { sha256 } from './hashing';
import { publishArtifactSet, type ArtifactPublisher, type PublishedObjectHead } from './publisher';

const enc = new TextEncoder();

const art = (key: string, body: string, immutable: boolean): GeneratedArtifact => ({
  key,
  bytes: enc.encode(body),
  contentType: 'application/json; charset=utf-8',
  sha256: sha256(enc.encode(body)),
  immutable,
});

/** In-memory stand-in for the create-only blob store, recording the exact write order. */
function store(seed: Record<string, { body: string; contentType?: string }> = {}, failWrites = new Set<string>()) {
  const data = new Map<string, { bytes: Uint8Array; contentType: string }>();
  for (const [key, value] of Object.entries(seed)) {
    data.set(key, { bytes: enc.encode(value.body), contentType: value.contentType ?? 'application/json; charset=utf-8' });
  }
  const order: string[] = [];
  const publisher: ArtifactPublisher = {
    async putImmutable(artifact) {
      order.push(`put:${artifact.key}`);
      if (failWrites.has(artifact.key)) throw new Error(`BLOB 403 forbidden: ${artifact.key}`);
      if (data.has(artifact.key)) throw new Error(`create-only: already exists ${artifact.key}`);
      data.set(artifact.key, { bytes: artifact.bytes, contentType: artifact.contentType });
    },
    async advancePointer(artifact) {
      order.push(`ptr:${artifact.key}`);
      data.set(artifact.key, { bytes: artifact.bytes, contentType: artifact.contentType });
    },
    async get(key) {
      return data.get(key)?.bytes;
    },
    async head(key) {
      const object = data.get(key);
      if (!object) return undefined;
      return { size: object.bytes.byteLength, sha256: sha256(object.bytes), contentType: object.contentType } as PublishedObjectHead;
    },
  };
  return { publisher, order, data };
}

const set = (immutables: GeneratedArtifact[]): GeneratedArtifactSet => {
  const discovery = art('.well-known/vgpu-examples.json', '{"d":1}', false);
  const latest = art('examples/v1/latest.json', '{"l":1}', false);
  return { revision: 'r', artifacts: [...immutables, discovery, latest], discoveryKey: discovery.key, latestKey: latest.key };
};

describe('publisher: create-only retry semantics', () => {
  const artifact = art('examples/v1/revisions/r/index.json', '{"same":1}', true);

  it('accepts a rejected write when the retained object is byte-identical', async () => {
    // Republishing an unchanged revision is a legitimate retry, not a failure.
    const { publisher, order } = store({ [artifact.key]: { body: '{"same":1}' } });
    await expect(publishArtifactSet(publisher, set([artifact]))).resolves.toBeUndefined();
    expect(order).toEqual([`put:${artifact.key}`, 'ptr:.well-known/vgpu-examples.json', 'ptr:examples/v1/latest.json']);
  });

  it('reports the real cause when the write fails and nothing is retained', async () => {
    // The bug this guards: a bare catch{} reduced a 403 to an opaque "mismatch".
    const { publisher } = store({}, new Set([artifact.key]));
    await expect(publishArtifactSet(publisher, set([artifact]))).rejects.toMatchObject({
      message: expect.stringContaining('Immutable write failed for'),
      cause: expect.objectContaining({ message: expect.stringContaining('BLOB 403 forbidden') }),
    });
  });

  it('never swallows a retained object with different bytes', async () => {
    // Exactly the origin-migration failure: same key, different bytes.
    const { publisher } = store({ [artifact.key]: { body: '{"different":2}' } });
    await expect(publishArtifactSet(publisher, set([artifact]))).rejects.toThrow(/mismatch/);
  });

  it('rejects a byte-identical object stored with the wrong content type', async () => {
    const { publisher } = store({ [artifact.key]: { body: '{"same":1}', contentType: 'text/plain' } });
    await expect(publishArtifactSet(publisher, set([artifact]))).rejects.toThrow(/head mismatch/);
  });

  it('does not advance the latest pointer when an immutable write fails', async () => {
    // The pointer is the transaction boundary: it must never name an incomplete revision.
    const { publisher, order, data } = store({}, new Set([artifact.key]));
    await expect(publishArtifactSet(publisher, set([artifact]))).rejects.toThrow();
    expect(order.filter((entry) => entry.startsWith('ptr:'))).toEqual([]);
    expect(data.has('examples/v1/latest.json')).toBe(false);
  });

  it('writes immutables, then discovery, then latest last', async () => {
    const { publisher, order } = store();
    const hook: string[] = [];
    await publishArtifactSet(publisher, set([artifact]), {
      beforeLatest: async () => {
        hook.push(`beforeLatest@${order.length}`);
      },
    });
    expect(order).toEqual([`put:${artifact.key}`, 'ptr:.well-known/vgpu-examples.json', 'ptr:examples/v1/latest.json']);
    expect(hook).toEqual(['beforeLatest@2']);
  });

  it('keeps a readable message when verification throws a non-Error', async () => {
    const hostile: ArtifactPublisher = {
      async putImmutable() {
        throw new Error('real write failure');
      },
      async advancePointer() {},
      async get() {
        return undefined;
      },
      async head() {
        throw 'not an Error object';
      },
    };
    // Stringified rather than read as `.message`, which would have rendered "undefined".
    await expect(publishArtifactSet(hostile, set([artifact]))).rejects.toThrow(/Immutable write failed for .*: not an Error object/);
  });
});
