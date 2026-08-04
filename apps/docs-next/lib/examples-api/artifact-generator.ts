import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { ExampleByteGraph } from './byte-graph';
import {
  EXAMPLES_BLOB_PREFIX,
  EXAMPLES_CONTRACT_ID,
  EXAMPLES_DISCOVERY_VERSION,
  EXAMPLES_ORIGIN,
  EXAMPLES_PROTOCOL,
  EXAMPLES_SCHEMA_SHA256,
} from './contracts';
import { artifactSetRevision, canonicalExampleBytes, canonicalRevisionBytes, sha256, validatePath } from './hashing';

export interface GeneratedArtifact {
  readonly key: string;
  readonly bytes: Uint8Array;
  readonly contentType: string;
  readonly sha256: string;
  readonly immutable: boolean;
}

export interface GeneratedArtifactSet {
  readonly revision: string;
  readonly artifacts: readonly GeneratedArtifact[];
  readonly discoveryKey: string;
  readonly latestKey: string;
}

const encoder = new TextEncoder();
const json = (value: unknown) => encoder.encode(`${JSON.stringify(value, null, 2)}\n`);
const url = (origin: string, key: string) => {
  const encodedKey = key.split('/').map(encodeURIComponent).join('/');
  return `${origin}/${key.startsWith(`${EXAMPLES_BLOB_PREFIX}/`) ? 'api/' : ''}${encodedKey}`;
};

export function generateExampleArtifacts(
  graph: ExampleByteGraph,
  origin: string = EXAMPLES_ORIGIN,
  // The oldest CLI that can actually consume these artifacts. 0.2.0-rc.0 and earlier pin a
  // single trusted host, so they reject vgpu.sh URLs outright -- advertising anything lower
  // would be a lie. NOTE: this gate is reachable for CLIs built after the #255 fix, which runs
  // assertTrustedUrl last during the handshake (schemaSha256 -> status -> minimumCliVersion ->
  // assertTrustedUrl). It remains unreachable for the already-published 0.2.0-rc.0 binaries, which
  // embed the old order permanently and keep surfacing VGPU-EXAMPLES-INTEGRITY instead of
  // VGPU-EXAMPLES-CLI-TOO-OLD. See examples-api.md, "Client compatibility and the version gate".
  minimumCliVersion = '0.2.0-rc.1',
): GeneratedArtifactSet {
  verifyGraph(graph);
  const normalizedOrigin = origin.replace(/\/$/, '');
  validateUri(normalizedOrigin, 'Artifact origin');
  // The published revision identifies the ARTIFACT SET, not just the source snapshot: these bytes
  // embed `normalizedOrigin` in every absolute URL, so a different origin must yield a different
  // revision. See artifactSetRevision().
  const revision = artifactSetRevision(graph.revision, normalizedOrigin);
  const base = `${EXAMPLES_BLOB_PREFIX}/revisions/${revision}`;
  const artifacts: GeneratedArtifact[] = [];
  const add = (key: string, bytes: Uint8Array, contentType: string, immutable: boolean) => {
    if (artifacts.some((artifact) => artifact.key === key)) throw new Error(`Duplicate artifact key: ${key}`);
    artifacts.push({ key, bytes, contentType, sha256: sha256(bytes), immutable });
  };

  const manifests = graph.examples.map((example) => {
    const files = example.files.map((file) => {
      validatePath(file.path);
      // `.raw` keeps checked-in canonical TypeScript bytes out of the docs compiler;
      // the manifest path remains the authored path and the response bytes are unchanged.
      const key = `${base}/examples/${example.id}/files/${file.path}.raw`;
      add(key, encoder.encode(file.text), file.contentType, true);
      return { path: file.path, contentType: file.contentType, size: file.size, sha256: file.sha256, url: url(normalizedOrigin, key) };
    });
    const document = {
      schemaVersion: 1, contractId: EXAMPLES_CONTRACT_ID, revision,
      id: example.id, ...example.metadata, aggregateSha256: example.aggregateSha256, files,
    };
    const key = `${base}/examples/${example.id}/manifest.json`;
    const bytes = json(document);
    add(key, bytes, 'application/json; charset=utf-8', true);
    return { example, key, sha256: sha256(bytes) };
  });

  const indexDocument = {
    schemaVersion: 1, contractId: EXAMPLES_CONTRACT_ID, revision, source: graph.source,
    examples: manifests.map(({ example, key, sha256: manifestSha256 }) => ({
      id: example.id, ...example.metadata, fileCount: example.files.length,
      aggregateSha256: example.aggregateSha256, manifestUrl: url(normalizedOrigin, key), manifestSha256,
    })),
  };
  const indexKey = `${base}/index.json`;
  const indexBytes = json(indexDocument);
  add(indexKey, indexBytes, 'application/json; charset=utf-8', true);

  const revisionDocument = {
    schemaVersion: 1, contractId: EXAMPLES_CONTRACT_ID, revision,
    objects: artifacts.map(({ key, bytes, sha256: objectSha256, contentType }) => ({ key, size: bytes.byteLength, sha256: objectSha256, contentType })),
  };
  add(`${base}/revision.json`, json(revisionDocument), 'application/json; charset=utf-8', true);

  const discoveryKey = '.well-known/vgpu-examples.json';
  add(discoveryKey, json({
    protocol: EXAMPLES_PROTOCOL,
    discoveryVersion: EXAMPLES_DISCOVERY_VERSION,
    contracts: [{
      id: EXAMPLES_CONTRACT_ID, schemaSha256: EXAMPLES_SCHEMA_SHA256, status: 'active',
      minimumCliVersion, indexUrl: url(normalizedOrigin, `${EXAMPLES_BLOB_PREFIX}/latest.json`),
    }],
  }), 'application/json; charset=utf-8', false);

  const latestKey = `${EXAMPLES_BLOB_PREFIX}/latest.json`;
  add(latestKey, json({
    schemaVersion: 1, contractId: EXAMPLES_CONTRACT_ID, revision,
    indexUrl: url(normalizedOrigin, indexKey), indexSha256: sha256(indexBytes),
  }), 'application/json; charset=utf-8', false);

  return { revision, artifacts, discoveryKey, latestKey };
}

export async function writeArtifactTree(set: GeneratedArtifactSet, outputDirectory: string): Promise<void> {
  for (const artifact of set.artifacts) {
    const destination = resolve(outputDirectory, artifact.key);
    if (!destination.startsWith(`${resolve(outputDirectory)}/`)) throw new Error(`Artifact escaped output tree: ${artifact.key}`);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, artifact.bytes);
  }
}

function verifyGraph(graph: ExampleByteGraph): void {
  if (typeof graph.source.repository !== 'string' || graph.source.repository.length === 0 ||
      typeof graph.source.gitCommit !== 'string' || graph.source.gitCommit.length === 0) {
    throw new Error('Graph source repository and git commit must be non-empty strings');
  }
  if (sha256(canonicalRevisionBytes(graph)) !== graph.revision) throw new Error('Graph revision hash mismatch');
  let total = 0;
  for (const example of graph.examples) {
    if (sha256(canonicalExampleBytes(example)) !== example.aggregateSha256) throw new Error(`Aggregate hash mismatch: ${example.id}`);
    for (const file of example.files) {
      const bytes = encoder.encode(file.text);
      total += bytes.byteLength;
      if (bytes.byteLength !== file.size || sha256(bytes) !== file.sha256) throw new Error(`File integrity mismatch: ${example.id}/${file.path}`);
    }
  }
  if (total > 32 * 1024 * 1024) throw new Error('Graph source exceeds 32 MiB');
}

/**
 * The origin must be a bare `scheme://host[:port]`: no path, query, fragment or credentials.
 * Every published URL is built by concatenating this value, so anything extra would be baked into
 * retained immutable bytes -- and because it also feeds artifactSetRevision(), two spellings of the
 * same origin would fork the revision. Comparing against `URL.origin` rejects all of it in one go.
 */
function validateUri(value: string, name: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute URI`);
  }
  if (parsed.origin !== value) {
    throw new Error(`${name} must be a bare origin (scheme://host[:port]), got: ${value}`);
  }
}
