import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EXAMPLES_SCHEMA_HASHES, EXAMPLES_SCHEMA_SHA256 } from './contracts';
import { EXAMPLES_SCHEMA_HASHES as CLI_HASHES, EXAMPLES_SCHEMA_SHA256 as CLI_SHA } from '../../../../packages/vgpu/lib/examples/contracts.js';

const digest = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');

describe('frozen schema copies', () => {
  it('keeps docs and embedded CLI schemas byte-identical with a recomputable contract hash', async () => {
    let frame = 'vgpu-examples-contract/v1\0';
    for (const file of Object.keys(EXAMPLES_SCHEMA_HASHES).sort()) {
      const docs = await readFile(resolve('apps/docs/lib/examples-api/schemas/v1', file));
      const cli = await readFile(resolve('packages/vgpu/lib/examples/schemas/v1', file));
      expect(cli).toEqual(docs);
      expect(digest(docs)).toBe(EXAMPLES_SCHEMA_HASHES[file as keyof typeof EXAMPLES_SCHEMA_HASHES]);
      frame += `${Buffer.byteLength(file)}:${file}\n${docs.byteLength}:${digest(docs)}\n`;
    }
    expect(digest(frame)).toBe(EXAMPLES_SCHEMA_SHA256);
    expect(CLI_HASHES).toEqual(EXAMPLES_SCHEMA_HASHES);
    expect(CLI_SHA).toBe(EXAMPLES_SCHEMA_SHA256);
  });
});
