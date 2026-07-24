import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import {
  EXAMPLE_BYTE_GRAPH_VERSION,
  type ExampleByteGraph,
  type ExampleByteRecord,
  type ExampleGraphSource,
  type ExampleMetadata,
  type UnhashedExampleRecord,
} from './byte-graph';

const SHA256 = /^[a-f0-9]{64}$/;
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TOKEN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const encoder = new TextEncoder();

export function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function field(value: string): string {
  return `${encoder.encode(value).byteLength}:${value}\n`;
}

function canonicalMetadata(metadata: ExampleMetadata): string {
  return [
    field(metadata.title),
    field(metadata.description),
    `${metadata.tags.length}\n`,
    ...metadata.tags.map(field),
    `${metadata.capabilities.length}\n`,
    ...metadata.capabilities.map(field),
  ].join('');
}

/** Domain-separated, length-framed aggregate identity. File order is significant. */
export function canonicalExampleBytes(example: ExampleByteRecord): Uint8Array {
  let value = 'vgpu-example-aggregate/v1\0';
  value += field(example.id);
  value += canonicalMetadata(example.metadata);
  value += `${example.files.length}\n`;
  for (const file of example.files) {
    value += field(file.path);
    value += field(file.contentType);
    value += `${file.size}\n${file.sha256}\n`;
  }
  return encoder.encode(value);
}

/** Domain-separated graph identity. generatedAt is intentionally not part of the graph. */
export function canonicalRevisionBytes(graph: Omit<ExampleByteGraph, 'revision'> | ExampleByteGraph): Uint8Array {
  let value = 'vgpu-example-byte-graph/v1\0';
  value += `${graph.graphVersion}\n${field(graph.source.repository)}${field(graph.source.gitCommit)}`;
  value += `${graph.examples.length}\n`;
  for (const example of graph.examples) {
    value += `${field(example.id)}${example.aggregateSha256}\n`;
  }
  return encoder.encode(value);
}

export function buildByteGraph(
  records: readonly UnhashedExampleRecord[],
  source: ExampleGraphSource,
): ExampleByteGraph {
  if (!source.repository || !source.gitCommit) throw new Error('Source repository and git commit are required');
  const seenIds = new Set<string>();
  const examples: ExampleByteRecord[] = records.map((record) => {
    validateId(record.id);
    if (seenIds.has(record.id)) throw new Error(`Duplicate example id: ${record.id}`);
    seenIds.add(record.id);
    validateMetadata(record.metadata, record.id);
    if (record.files.length === 0 || record.files.length > 128) {
      throw new Error(`Example ${record.id} must contain 1-128 files`);
    }
    const seenPaths = new Set<string>();
    const files = record.files.map((file) => {
      validatePath(file.path);
      if (seenPaths.has(file.path)) throw new Error(`Duplicate file path in ${record.id}: ${file.path}`);
      seenPaths.add(file.path);
      validateText(file.text, `${record.id}/${file.path}`);
      const bytes = encoder.encode(file.text);
      if (bytes.byteLength > 2 * 1024 * 1024) throw new Error(`File exceeds 2 MiB: ${record.id}/${file.path}`);
      return { ...file, size: bytes.byteLength, sha256: sha256(bytes) };
    });
    const partial = { id: record.id, metadata: record.metadata, files, aggregateSha256: '' };
    return { ...partial, aggregateSha256: sha256(canonicalExampleBytes(partial)) };
  });
  const partial = { graphVersion: EXAMPLE_BYTE_GRAPH_VERSION, source, examples };
  return { ...partial, revision: sha256(canonicalRevisionBytes(partial)) };
}

function validateId(id: string): void {
  if (!ID.test(id)) throw new Error(`Invalid example id: ${id}`);
}

export function validatePath(path: string): void {
  if (!path || path !== posix.normalize(path) || path.startsWith('/') || path.includes('\\') || path.includes('%')) {
    throw new Error(`Invalid relative file path: ${path}`);
  }
  if (path.split('/').some((part) => part === '..' || part === '.' || !part)) throw new Error(`Invalid relative file path: ${path}`);
  if (/^[A-Za-z]:/.test(path) || /[\0-\x1f\x7f]/.test(path)) throw new Error(`Invalid relative file path: ${path}`);
}

function validateText(text: string, name: string): void {
  if (text.includes('\r') || text.includes('\0') || !text.endsWith('\n')) {
    throw new Error(`Source must be UTF-8 text with LF endings and a final LF: ${name}`);
  }
}

function validateMetadata(metadata: ExampleMetadata, id: string): void {
  if (!metadata.title.trim() || !metadata.description.trim()) throw new Error(`Missing metadata for ${id}`);
  for (const [kind, values] of [['tag', metadata.tags], ['capability', metadata.capabilities]] as const) {
    const seen = new Set<string>();
    for (const value of values) {
      if (!TOKEN.test(value)) throw new Error(`Invalid ${kind} for ${id}: ${value}`);
      if (seen.has(value)) throw new Error(`Duplicate ${kind} for ${id}: ${value}`);
      seen.add(value);
    }
  }
}

export function assertSha256(value: string, label: string): void {
  if (!SHA256.test(value)) throw new Error(`Invalid SHA-256 for ${label}`);
}
