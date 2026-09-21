import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { exampleSources } from '../examples-source.generated';
import { adaptCanonicalSourceExport } from './adapter-v1';
import { generateExampleArtifacts } from './artifact-generator';
import { SOURCE_SNAPSHOT_PREFIX, sha256, sourceSnapshotIdentity } from './hashing';

const SNAPSHOT_FILE = 'apps/docs/lib/examples-source.generated.ts';
const repository = 'https://github.com/vgpu/vgpu';
const snapshotBytes = await readFile(resolve(SNAPSHOT_FILE));
const identity = sourceSnapshotIdentity(snapshotBytes);
const generate = (gitCommit: string) => generateExampleArtifacts(adaptCanonicalSourceExport(exampleSources, { repository, gitCommit }));

describe('content-derived source snapshot identity', () => {
  it('digests the exact snapshot bytes without consulting git', () => {
    expect(identity).toBe(`${SOURCE_SNAPSHOT_PREFIX}${sha256(snapshotBytes)}`);
    expect(identity).toMatch(/^sha256:[a-f0-9]{64}$/);
    // Not a commit SHA: never usable as a `…/commit/<value>` reference.
    expect(identity).not.toMatch(/^[a-f0-9]{40}$/);
  });

  it('produces identical artifacts for identical source content and different ones for changed content', () => {
    const first = generate(identity);
    const second = generate(sourceSnapshotIdentity(Buffer.from(snapshotBytes)));
    expect(second.revision).toBe(first.revision);
    expect(second.artifacts.map(({ key, sha256: digest }) => `${key}:${digest}`))
      .toEqual(first.artifacts.map(({ key, sha256: digest }) => `${key}:${digest}`));

    const changed = generate(sourceSnapshotIdentity(Buffer.concat([snapshotBytes, Buffer.from('// touched\n')])));
    expect(changed.revision).not.toBe(first.revision);
  });

  it('pins an LF checkout for the byte-compared paths so the digest is platform independent', async () => {
    // A CRLF checkout (`core.autocrlf=true` on Windows) would change the physical bytes of a
    // content-identical tree and therefore the revision, so the EOL is versioned in .gitattributes.
    expect(snapshotBytes.includes(0x0d)).toBe(false);
    const attributes = await readFile(resolve('.gitattributes'), 'utf8');
    expect(attributes, `.gitattributes must pin ${SNAPSHOT_FILE} to LF`)
      .toContain(`${SNAPSHOT_FILE} text eol=lf\n`);
  });

  it('keeps the revision independent of git history and merge strategy', async () => {
    // The generator must not derive identity from commits: any `git log`/child-process call would
    // reintroduce squash-merge and shallow-checkout staleness (see issue #199).
    const generator = await readFile(resolve('apps/docs/scripts/generate-examples-api.mjs'), 'utf8');
    expect(generator).not.toMatch(/child_process|git log|--format=%H/);
    expect(generator).toContain('sourceSnapshotIdentity');
  });

  it('generates deployment artifacts during dev and build without tracking them', async () => {
    const packageJson = JSON.parse(await readFile(resolve('apps/docs/package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(packageJson.scripts['examples-api:generate']).toBe('node scripts/generate-examples-api.mjs');
    expect(packageJson.scripts.predev).toMatch(/ingest-examples\.mjs.*examples-api:generate/);
    expect(packageJson.scripts.prebuild).toMatch(/ingest-examples\.mjs.*examples-api:generate/);

    const ignore = await readFile(resolve('apps/docs/.gitignore'), 'utf8');
    expect(ignore.split(/\r?\n/)).toContain('generated/examples-api');
  });
});
