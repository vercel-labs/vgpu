import { get } from '@vercel/blob';
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { sha256 } from './hashing';
import { readSafeLocalFile } from './safe-local-path';
import {
  DISCOVERY_ARTIFACT_KEY,
  LATEST_ARTIFACT_KEY,
  responseLimit,
} from './route-config';

export interface StoredArtifact {
  readonly bytes: Uint8Array;
  readonly contentType: string;
  readonly sha256: string;
}

interface RevisionObject {
  readonly key: string;
  readonly size: number;
  readonly sha256: string;
  readonly contentType: string;
}

interface RevisionDocument {
  readonly revision: string;
  readonly objects: readonly RevisionObject[];
}

export async function readMutableArtifact(key: string): Promise<StoredArtifact | undefined> {
  if (key !== DISCOVERY_ARTIFACT_KEY && key !== LATEST_ARTIFACT_KEY) return undefined;
  const bytes = await readRawObject(key, responseLimit(key));
  if (!bytes) return undefined;
  return { bytes, contentType: 'application/json; charset=utf-8', sha256: sha256(bytes) };
}

export async function readRevisionArtifact(revision: string, key: string): Promise<StoredArtifact | undefined> {
  const base = `examples/v1/revisions/${revision}`;
  if (!key.startsWith(`${base}/`)) return undefined;
  const revisionKey = `${base}/revision.json`;
  const revisionBytes = await readRawObject(revisionKey, responseLimit(revisionKey));
  if (!revisionBytes) return undefined;
  const document = parseRevisionDocument(revisionBytes, revision);

  if (key === revisionKey) {
    return { bytes: revisionBytes, contentType: 'application/json; charset=utf-8', sha256: sha256(revisionBytes) };
  }

  const expected = document.objects.find((object) => object.key === key);
  if (!expected || expected.size > responseLimit(key)) return undefined;
  const bytes = await readRawObject(key, responseLimit(key));
  if (!bytes) return undefined;
  if (bytes.byteLength !== expected.size || sha256(bytes) !== expected.sha256) {
    throw new Error(`Stored artifact integrity mismatch: ${key}`);
  }
  return { bytes, contentType: withCharset(expected.contentType), sha256: expected.sha256 };
}

function parseRevisionDocument(bytes: Uint8Array, expectedRevision: string): RevisionDocument {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new Error('Stored revision manifest is invalid JSON');
  }
  if (!value || typeof value !== 'object') throw new Error('Stored revision manifest is invalid');
  const document = value as Partial<RevisionDocument>;
  if (document.revision !== expectedRevision || !Array.isArray(document.objects) || document.objects.length > 512) {
    throw new Error('Stored revision manifest is invalid');
  }
  for (const object of document.objects) {
    if (!object || typeof object.key !== 'string' || !Number.isSafeInteger(object.size) || object.size < 0 ||
        typeof object.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(object.sha256) || typeof object.contentType !== 'string') {
      throw new Error('Stored revision manifest is invalid');
    }
  }
  return document as RevisionDocument;
}

/**
 * Latest-only serving reads the generated tree that ships inside the deployment, so `local` is the
 * default everywhere -- including on Vercel, where the auto-deploy IS the publish step. `blob` is
 * still selectable for the dormant versioned-retention mode and stays fail-closed without a token:
 * serving unverified bytes would be worse than serving nothing.
 */
async function readRawObject(key: string, maximumBytes: number): Promise<Uint8Array | undefined> {
  const mode = process.env.VGPU_EXAMPLES_ARTIFACT_STORE ?? 'local';
  if (mode === 'local') return readLocalObject(key, maximumBytes);
  if (mode === 'blob') return readBlobObject(key, maximumBytes);
  throw new Error(`Unsupported VGPU_EXAMPLES_ARTIFACT_STORE: ${mode}`);
}

const LOCAL_ROOT_LAYOUTS = ['generated/examples-api', 'apps/docs/generated/examples-api'] as const;
let cachedLocalRoot: string | undefined;

/**
 * Locates the generated tree bundled with the deployment.
 *
 * `process.cwd()` is the anchor rather than an absolute runtime path: on Vercel the working
 * directory is the deployed project root, so hardcoding `/var/task` would break `next dev`,
 * `next start`, tests, and any future runtime. Two layouts are probed because traced files are
 * placed relative to the file-tracing root, which is the app directory for a standalone build and
 * the workspace root for a monorepo build -- the sentinel file decides which one is real instead of
 * assuming. A negative probe is never cached, so a tree that appears later is still picked up.
 */
async function localRoot(): Promise<string> {
  const configuredRoot = process.env.VGPU_EXAMPLES_LOCAL_ROOT;
  if (configuredRoot) return resolve(configuredRoot);
  if (cachedLocalRoot) return cachedLocalRoot;
  for (const layout of LOCAL_ROOT_LAYOUTS) {
    const candidate = resolve(process.cwd(), layout);
    try {
      await access(resolve(candidate, LATEST_ARTIFACT_KEY));
      cachedLocalRoot = candidate;
      return candidate;
    } catch {
      // Wrong layout for this runtime; try the next one.
    }
  }
  return resolve(process.cwd(), LOCAL_ROOT_LAYOUTS[0]);
}

async function readLocalObject(key: string, maximumBytes: number): Promise<Uint8Array | undefined> {
  return readSafeLocalFile(await localRoot(), key, maximumBytes);
}

async function readBlobObject(key: string, maximumBytes: number): Promise<Uint8Array | undefined> {
  const token = process.env.VGPU_EXAMPLES_VERCEL_BLOB_READ_WRITE_TOKEN;
  if (!token) throw new Error('Missing VGPU_EXAMPLES_VERCEL_BLOB_READ_WRITE_TOKEN');
  const result = await get(key, { access: 'public', useCache: false, token });
  if (!result?.stream) return undefined;
  const reader = result.stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximumBytes) throw new Error(`Stored artifact exceeds response limit: ${key}`);
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

function withCharset(contentType: string): string {
  return contentType.startsWith('text/') && !contentType.includes(';') ? `${contentType}; charset=utf-8` : contentType;
}
