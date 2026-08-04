import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { exampleSources } from '../examples-source.generated';
import { adaptCanonicalSourceExport } from './adapter-v1';
import { generateExampleArtifacts } from './artifact-generator';
import { SOURCE_SNAPSHOT_PREFIX, sha256, sourceSnapshotIdentity } from './hashing';

const SNAPSHOT_FILE = 'apps/docs/lib/examples-source.generated.ts';
const GENERATED_TREE = 'apps/docs/generated/examples-api';
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
    for (const path of [SNAPSHOT_FILE, `${GENERATED_TREE}/**`]) {
      expect(attributes, `.gitattributes must pin ${path} to LF`).toContain(`${path} text eol=lf\n`);
    }
  });

  it('keeps the revision independent of git history and merge strategy', async () => {
    // The generator must not derive identity from commits: any `git log`/child-process call would
    // reintroduce squash-merge and shallow-checkout staleness (see issue #199).
    const generator = await readFile(resolve('apps/docs/scripts/generate-examples-api.mjs'), 'utf8');
    expect(generator).not.toMatch(/child_process|git log|--format=%H/);
    expect(generator).toContain('sourceSnapshotIdentity');
  });

  it('matches the checked-in artifact tree byte for byte', async () => {
    const set = generate(identity);
    for (const artifact of set.artifacts) {
      const bytes = await readFile(resolve(GENERATED_TREE, artifact.key));
      expect(sha256(bytes), `stale checked-in artifact: ${artifact.key}`).toBe(artifact.sha256);
    }
    const index = JSON.parse(
      await readFile(resolve(GENERATED_TREE, `examples/v1/revisions/${set.revision}/index.json`), 'utf8'),
    ) as { revision: string; source: { gitCommit: string } };
    expect(index.revision).toBe(set.revision);
    expect(index.source.gitCommit).toBe(identity);
  });
});
