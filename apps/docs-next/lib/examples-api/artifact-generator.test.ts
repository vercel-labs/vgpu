import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { exampleSources } from '../examples-source.generated';
import { adaptCanonicalSourceExport } from './adapter-v1';
import { generateExampleArtifacts, writeArtifactTree } from './artifact-generator';
import { artifactSetRevision, canonicalRevisionBytes, sha256, sourceSnapshotIdentity } from './hashing';

const graph = adaptCanonicalSourceExport(exampleSources, { repository: 'https://github.com/vgpu/vgpu', gitCommit: sourceSnapshotIdentity('canonical-source-snapshot-fixture\n') });

async function tree(root: string, dir = root): Promise<Record<string, string>> {
  const output: Record<string, string> = {};
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) Object.assign(output, await tree(root, path));
    else output[relative(root, path)] = (await readFile(path)).toString('base64');
  }
  return output;
}

describe('revision artifact generator', () => {
  it('generates byte-identical trees twice with independently valid object hashes', async () => {
    const one = generateExampleArtifacts(graph);
    const two = generateExampleArtifacts(graph);
    expect(two).toEqual(one);
    const firstDir = await mkdtemp(join(tmpdir(), 'vgpu-api-one-'));
    const secondDir = await mkdtemp(join(tmpdir(), 'vgpu-api-two-'));
    await writeArtifactTree(one, firstDir);
    await writeArtifactTree(two, secondDir);
    expect(await tree(secondDir)).toEqual(await tree(firstDir));
    for (const artifact of one.artifacts) expect(sha256(artifact.bytes)).toBe(artifact.sha256);
  });

  it('preserves the exact CodeViewer fractal transport bytes in raw artifacts', () => {
    const set = generateExampleArtifacts(graph);
    const fractal = graph.examples.find((example) => example.id === 'raymarched-fractal')!;
    for (const file of fractal.files) {
      const artifact = set.artifacts.find((candidate) => candidate.key.endsWith(`/raymarched-fractal/files/${file.path}.raw`))!;
      expect(Buffer.from(artifact.bytes).toString('utf8')).toBe(file.text);
      expect(artifact.sha256).toBe(file.sha256);
    }
  });

  it('rejects a graph whose verified bytes were changed', () => {
    const changed = structuredClone(graph);
    (changed.examples[0]!.files[0] as { text: string }).text += '// changed\n';
    expect(() => generateExampleArtifacts(changed)).toThrow(/integrity|revision/i);
  });

  it('rejects pointer URLs and source strings that violate the frozen index schema', () => {
    expect(() => generateExampleArtifacts(graph, 'not a url')).toThrow(/origin|uri/i);

    for (const field of ['repository', 'gitCommit'] as const) {
      const emptySource = structuredClone(graph);
      (emptySource.source as { repository: string; gitCommit: string })[field] = '';
      (emptySource as { revision: string }).revision = sha256(canonicalRevisionBytes(emptySource));
      expect(() => generateExampleArtifacts(emptySource)).toThrow(/source|repository|commit/i);
    }
  });
});

describe('revision identity covers the serving origin', () => {
  // Regression guard. The revision used to digest the source snapshot alone, so re-generating for a
  // new origin produced DIFFERENT bytes under the SAME revision path. The create-only publisher
  // then refused to overwrite the retained objects and failed with `Published object byte mismatch`.
  // A revision must name exactly one immutable byte set.
  it('derives a different revision for a different origin', () => {
    const first = generateExampleArtifacts(graph, 'https://vgpu.sh');
    const second = generateExampleArtifacts(graph, 'https://vgpu.labs.vercel.dev');

    expect(second.revision).not.toBe(first.revision);
    // The bytes really do differ, which is exactly why the revision has to.
    const indexOf = (set: typeof first) =>
      set.artifacts.find((artifact) => artifact.key.endsWith('/index.json'))!;
    expect(indexOf(second).sha256).not.toBe(indexOf(first).sha256);
    // ...and each set is namespaced under its own immutable revision prefix.
    for (const artifact of first.artifacts.filter((candidate) => candidate.immutable)) {
      expect(artifact.key).toContain(`/revisions/${first.revision}/`);
      expect(artifact.key).not.toContain(second.revision);
    }
  });

  it('keeps the revision deterministic for the same source and origin', () => {
    const first = generateExampleArtifacts(graph, 'https://vgpu.sh');
    const second = generateExampleArtifacts(graph, 'https://vgpu.sh');

    expect(second.revision).toBe(first.revision);
    expect(second.artifacts).toEqual(first.artifacts);
    // A trailing slash is normalized away, so it must not fork the revision.
    expect(generateExampleArtifacts(graph, 'https://vgpu.sh/').revision).toBe(first.revision);
  });

  it('separates the artifact-set revision from the source-graph revision', () => {
    // The graph revision still identifies the source snapshot; the published revision identifies
    // the artifact set. Conflating them is what caused the bug above.
    const set = generateExampleArtifacts(graph, 'https://vgpu.sh');
    expect(set.revision).not.toBe(graph.revision);
    expect(set.revision).toBe(artifactSetRevision(graph.revision, 'https://vgpu.sh'));
    expect(set.revision).toMatch(/^[a-f0-9]{64}$/);
  });
});
