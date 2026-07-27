// Stages the pinned depth-estimation ONNX models into `public/models/depth/` so
// the browser loads them same-origin. No CDN is ever used by a docs example.
//
// The three selectable models total ~163 MiB, far past anything that belongs in
// git history, so they follow the same rule as the ONNX Runtime binaries in
// `public/ort/`: gitignored, fetched from a pinned source, verified by SHA-256.
// A mismatch is a hard failure — a silently wrong model would be far worse than
// a failed build.
//
// FastDepth has no direct download: upstream only publishes it inside a 724 MB
// aggregate archive. Rather than pull all of that, the tar stream is parsed on
// the fly and aborted as soon as the member is complete, which costs ~7.6 MiB.
//
// Usage:
//   node scripts/prepare-depth-models.mjs           stage (idempotent)
//   node scripts/prepare-depth-models.mjs --check   verify staged bytes
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createGunzip } from 'node:zlib';

const docsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(docsDir, 'public', 'models', 'depth');
const manifestFile = path.join(outDir, 'manifest.json');

const FASTDEPTH_ARCHIVE =
  'https://s3.ap-northeast-2.wasabisys.com/pinto-model-zoo/146_FastDepth/resources.tar.gz';

/**
 * Pinned candidates. Every hash was verified offline against the ONNX graph and
 * the ONNX Runtime CPU EP; see tools/models/depth-candidates/CANDIDATES.md.
 */
const models = [
  {
    file: 'fastdepth-320x256.onnx',
    bytes: 5420454,
    sha256: 'dfc532a08f0ee34283d890d845e3824973f17240ad1d7eb617d9959ec8dc23c9',
    license: 'MIT — dwofk/fast-depth, exported by PINTO_model_zoo #146',
    source: {
      kind: 'tar-member',
      url: FASTDEPTH_ARCHIVE,
      member: 'saved_model_256x320/fast_depth_256x320.onnx',
    },
  },
  {
    file: 'midas-v21-small-256.onnx',
    bytes: 66764249,
    sha256: '2d8c6cb8f415229daf1eb041024208e2608c9f98e17c81cc7c6ecb449c56fd58',
    license: 'MIT — isl-org/MiDaS v2_1',
    source: {
      kind: 'url',
      url: 'https://github.com/isl-org/MiDaS/releases/download/v2_1/model-small.onnx',
    },
  },
  {
    file: 'dav2-small.onnx',
    bytes: 99060839,
    sha256: 'afb6a5c28f3b6bf1618c6e43f02073ef9dfdc70e937502d51603e57b0a1df10c',
    license: 'Apache-2.0 — depth-anything/Depth-Anything-V2-Small (onnx-community export)',
    source: {
      kind: 'url',
      url: 'https://huggingface.co/onnx-community/depth-anything-v2-small/resolve/main/onnx/model.onnx',
    },
  },
];

const check = process.argv.slice(2).includes('--check');

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const mib = (bytes) => `${(bytes / 1024 / 1024).toFixed(2)} MiB`;

/**
 * Reads one member out of a remote .tar.gz without downloading the rest.
 *
 * Tar is a flat sequence of 512-byte headers followed by padded payloads, so the
 * stream can be walked until the wanted member ends and then abandoned. The
 * fetch is aborted at that point, which is what keeps this to a few MiB.
 */
async function fetchTarMember(url, member) {
  const controller = new AbortController();
  const response = await fetch(url, { signal: controller.signal });
  if (!response.ok) throw new Error(`GET ${url} -> HTTP ${response.status}`);

  // Aborting mid-stream makes both halves of the pipe emit; those errors are
  // expected and must not crash the build.
  const source = Readable.fromWeb(response.body);
  const gunzip = createGunzip();
  source.on('error', () => {});
  gunzip.on('error', () => {});
  source.pipe(gunzip);

  let pending = Buffer.alloc(0);
  let skipRemaining = 0;
  /** @type {{ size: number, padded: number, chunks: Buffer[], read: number } | undefined} */
  let capturing;
  /** @type {Buffer | undefined} */
  let found;

  try {
    outer: for await (const chunk of gunzip) {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;

      for (;;) {
        if (skipRemaining > 0) {
          const drop = Math.min(skipRemaining, pending.length);
          pending = pending.subarray(drop);
          skipRemaining -= drop;
          if (skipRemaining > 0) break;
          continue;
        }

        if (capturing) {
          const want = capturing.padded - capturing.read;
          const take = Math.min(want, pending.length);
          capturing.chunks.push(pending.subarray(0, take));
          capturing.read += take;
          pending = pending.subarray(take);
          if (capturing.read < capturing.padded) break;
          found = Buffer.concat(capturing.chunks).subarray(0, capturing.size);
          break outer;
        }

        if (pending.length < 512) break;
        const header = pending.subarray(0, 512);
        pending = pending.subarray(512);
        const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
        if (!name) continue; // end-of-archive padding
        const size = Number.parseInt(
          header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim() || '0',
          8,
        );
        const padded = Math.ceil(size / 512) * 512;
        if (name === member) capturing = { size, padded, chunks: [], read: 0 };
        else skipRemaining = padded;
      }
    }
  } finally {
    // Stop the transfer as soon as the member is complete: this is what keeps a
    // 724 MB archive down to a few MiB on the wire.
    controller.abort();
    source.destroy();
    gunzip.destroy();
  }

  if (!found) throw new Error(`member ${member} not found in ${url}`);
  return found;
}

async function download(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`GET ${url} -> HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function readStaged(model) {
  const bytes = await readFile(path.join(outDir, model.file)).catch(() => undefined);
  if (!bytes) return { ok: false, reason: 'missing' };
  if (bytes.byteLength !== model.bytes) {
    return { ok: false, reason: `is ${bytes.byteLength} bytes, expected ${model.bytes}` };
  }
  const hash = sha256(bytes);
  if (hash !== model.sha256) return { ok: false, reason: `sha256 ${hash} != ${model.sha256}` };
  return { ok: true };
}

const manifest = {
  description:
    'Generated by scripts/prepare-depth-models.mjs. Same-origin depth models; gitignored, hash-pinned.',
  models: models.map(({ file, bytes, sha256: hash, license, source }) => ({
    file,
    bytes,
    sha256: hash,
    license,
    source: source.kind === 'url' ? source.url : `${source.url}#${source.member}`,
  })),
};
const manifestJson = `${JSON.stringify(manifest, null, 2)}\n`;

if (check) {
  const failures = [];
  const previous = await readFile(manifestFile, 'utf8').catch(() => undefined);
  if (previous !== manifestJson) {
    failures.push(`${path.relative(docsDir, manifestFile)} is missing or stale.`);
  }
  for (const model of models) {
    const state = await readStaged(model);
    if (!state.ok) failures.push(`public/models/depth/${model.file} ${state.reason}.`);
  }
  if (failures.length) {
    console.error(
      `${failures.join('\n')}\nRun \`pnpm --filter docs depth:models\` to stage the pinned models.`,
    );
    process.exitCode = 1;
  } else {
    console.log(`Depth models verified: ${models.length} files, ${mib(models.reduce((n, m) => n + m.bytes, 0))}.`);
  }
} else {
  await mkdir(outDir, { recursive: true });
  let fetched = 0;
  for (const model of models) {
    const state = await readStaged(model);
    if (state.ok) {
      console.log(`  ok      ${model.file} (${mib(model.bytes)}, cached)`);
      continue;
    }
    console.log(`  fetch   ${model.file} (${mib(model.bytes)}) — ${state.reason}`);
    const bytes =
      model.source.kind === 'tar-member'
        ? await fetchTarMember(model.source.url, model.source.member)
        : await download(model.source.url);

    // Fail loudly: a mismatched model must never reach the browser.
    if (bytes.byteLength !== model.bytes || sha256(bytes) !== model.sha256) {
      throw new Error(
        `${model.file} failed verification: got ${bytes.byteLength} bytes / sha256 ${sha256(bytes)}, ` +
          `expected ${model.bytes} / ${model.sha256}. Refusing to stage.`,
      );
    }
    await writeFile(path.join(outDir, model.file), bytes);
    fetched += 1;
  }
  await writeFile(manifestFile, manifestJson);
  console.log(
    `Staged ${models.length} depth models (${mib(models.reduce((n, m) => n + m.bytes, 0))}) into public/models/depth/` +
      `${fetched ? ` — ${fetched} downloaded` : ' — all cached'}.`,
  );
}
