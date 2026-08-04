import { EXAMPLES_BLOB_PREFIX } from './contracts';

export const DISCOVERY_ARTIFACT_KEY = '.well-known/vgpu-examples.json';
export const LATEST_ARTIFACT_KEY = `${EXAMPLES_BLOB_PREFIX}/latest.json`;
export const DISCOVERY_MAX_BYTES = 32 * 1024;
export const INDEX_MAX_BYTES = 1024 * 1024;
export const MANIFEST_MAX_BYTES = 256 * 1024;
export const SOURCE_MAX_BYTES = 2 * 1024 * 1024;
export const MUTABLE_CACHE_CONTROL = 'public, max-age=60, must-revalidate';
export const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';

const SHA256 = /^[a-f0-9]{64}$/;
const UNSAFE_SEGMENT = /[\\%\0-\x1f\x7f]/;

export function revisionArtifactKey(revision: string, artifact: readonly string[]): string | undefined {
  if (!SHA256.test(revision) || artifact.length === 0) return undefined;
  if (artifact.some((part) => !part || part === '.' || part === '..' || UNSAFE_SEGMENT.test(part))) return undefined;
  return `${EXAMPLES_BLOB_PREFIX}/revisions/${revision}/${artifact.join('/')}`;
}

export function responseLimit(key: string): number {
  if (key === DISCOVERY_ARTIFACT_KEY || key === LATEST_ARTIFACT_KEY) return DISCOVERY_MAX_BYTES;
  if (key.endsWith('/index.json') || key.endsWith('/revision.json')) return INDEX_MAX_BYTES;
  if (key.endsWith('/manifest.json')) return MANIFEST_MAX_BYTES;
  return SOURCE_MAX_BYTES;
}
