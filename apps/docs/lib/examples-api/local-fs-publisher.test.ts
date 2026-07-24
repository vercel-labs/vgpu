import { mkdtemp, readdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { exampleSources } from '../examples-source.generated';
import { adaptCanonicalSourceExport } from './adapter-v1';
import { generateExampleArtifacts } from './artifact-generator';
import { LocalFsPublisher } from './local-fs-publisher';
import { publishArtifactSet, type ArtifactPublisher } from './publisher';

const set = generateExampleArtifacts(adaptCanonicalSourceExport(exampleSources, { repository: 'repo', gitCommit: 'abc' }));

describe('LocalFsPublisher', () => {
  it('publishes immutable revisions create-only and advances the pointer last', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vgpu-publisher-'));
    const publisher = new LocalFsPublisher(root);
    await publishArtifactSet(publisher, set);
    const latest = set.artifacts.find((artifact) => artifact.key === set.latestKey)!;
    expect(await publisher.get(set.latestKey)).toEqual(latest.bytes);
    const immutable = set.artifacts.find((artifact) => artifact.immutable)!;
    await expect(publisher.putImmutable(immutable)).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await publisher.get(immutable.key)).toEqual(immutable.bytes);
  });

  it('rejects a symlinked parent instead of publishing outside its root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vgpu-publisher-symlink-'));
    const external = await mkdtemp(join(tmpdir(), 'vgpu-publisher-external-'));
    await symlink(external, join(root, 'examples'), 'dir');
    const publisher = new LocalFsPublisher(root);
    const immutable = set.artifacts.find((artifact) => artifact.immutable)!;

    await expect(publisher.putImmutable(immutable)).rejects.toThrow(/symbolic link|unsafe/i);
    expect(await readdir(external)).toEqual([]);
  });

  it('does not advance latest when immutable publication fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vgpu-publisher-fail-'));
    const local = new LocalFsPublisher(root);
    const failing: ArtifactPublisher = {
      ...local,
      putImmutable: async () => { throw new Error('injected immutable failure'); },
      get: local.get.bind(local), head: local.head.bind(local), advancePointer: local.advancePointer.bind(local),
    };
    await expect(publishArtifactSet(failing, set)).rejects.toThrow(/Published object head mismatch/);
    expect(await local.get(set.latestKey)).toBeUndefined();
  });

  it('keeps latest unchanged when pre-pointer deployment verification fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vgpu-publisher-pre-pointer-'));
    const publisher = new LocalFsPublisher(root);
    await expect(publishArtifactSet(publisher, set, {
      beforeLatest: async () => {
        expect(await publisher.get(set.latestKey)).toBeUndefined();
        throw new Error('injected deployment verification failure');
      },
    })).rejects.toThrow('injected deployment verification failure');
    expect(await publisher.get(set.latestKey)).toBeUndefined();
    expect(await publisher.get(set.discoveryKey)).toBeDefined();
  });

  it('fails loudly when the latest pointer write is not freshly retained', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vgpu-publisher-noop-latest-'));
    const local = new LocalFsPublisher(root);
    const noOpLatest: ArtifactPublisher = {
      putImmutable: local.putImmutable.bind(local), get: local.get.bind(local), head: local.head.bind(local),
      advancePointer: async (artifact) => {
        if (artifact.key !== set.latestKey) await local.advancePointer(artifact);
      },
    };

    await expect(publishArtifactSet(noOpLatest, set)).rejects.toThrow(`Published object head mismatch: ${set.latestKey}`);
    expect(await local.get(set.latestKey)).toBeUndefined();
  });

  it('retains an old revision when a new latest revision is published', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vgpu-publisher-retain-'));
    const publisher = new LocalFsPublisher(root);
    await publishArtifactSet(publisher, set);
    const old = set.artifacts.find((artifact) => artifact.immutable)!;
    const changedGraph = adaptCanonicalSourceExport(exampleSources, { repository: 'repo', gitCommit: 'def' });
    await publishArtifactSet(publisher, generateExampleArtifacts(changedGraph));
    expect(await publisher.get(old.key)).toEqual(old.bytes);
  });
});
