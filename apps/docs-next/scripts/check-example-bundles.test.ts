import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const script = fileURLToPath(new URL('./check-example-bundles.mjs', import.meta.url));
const slugs = [
  'gradient',
  'triangle-led-front',
  'anti-aliasing',
  'post-processing',
  'black-hole',
  'fluid',
  'instanced-rendering',
  'batch-rendering',
  'fft-ocean',
  'raymarched-fractal',
];

// ANCHOR TGEIST-08: `markerRoot` is the only addition to this transplanted suite. It exists to pin
// the one edit the script needed in this tree (`apps/docs(?:-next)?/examples/<slug>/` instead of a
// hardcoded `apps/docs/`): the default keeps every original assertion running against the old
// app's marker shape, and the extra test at the bottom proves the same failure is raised for the
// shape Turbopack actually emits while the app lives in `apps/docs-next`. Without it, the
// isolation assertion would pass vacuously here and nothing would notice.
function writeFixture(options: { foreign?: boolean; oversized?: boolean; staleChunks?: boolean; markerRoot?: string } = {}) {
  const markerRoot = options.markerRoot ?? 'apps/docs';
  const root = mkdtempSync(path.join(tmpdir(), 'example-bundles-'));
  const chunks = path.join(root, 'chunks');
  mkdirSync(chunks);

  // A source tree the fixture controls the timestamps of, so the freshness
  // check can be exercised without touching the real one.
  const source = path.join(root, 'source');
  mkdirSync(path.join(source, 'examples', 'gradient'), { recursive: true });
  const sourceFile = path.join(source, 'examples', 'gradient', 'renderer.ts');
  writeFileSync(sourceFile, 'export const renderer = 1;\n');

  const loaders = slugs.map((slug, index) => {
    const property = slug.includes('-') ? JSON.stringify(slug) : slug;
    return `${property}:()=>e.A(${index + 1})`;
  }).join(',');
  const manifests = slugs.map((slug, index) => `,${index + 1},()=>Promise.all(["static/chunks/${slug}.js"].map(x=>x))`).join('');
  writeFileSync(path.join(chunks, 'host.js'), `let a={${loaders}};${manifests}`);

  for (const slug of slugs) {
    const foreignMarker = options.foreign && slug === 'gradient'
      ? `${markerRoot}/examples/fluid/renderer.ts`
      : `${markerRoot}/examples/${slug}/renderer.ts`;
    const padding = options.oversized && slug === 'gradient'
      ? Array.from({ length: 5_000 }, (_, index) => `${index.toString(36).padStart(6, '0')}-${(index * 7919).toString(36)}`).join('|')
      : '';
    writeFileSync(path.join(chunks, `${slug}.js`), `${foreignMarker}\n${padding}`);
  }

  const budgetsPath = path.join(root, 'budgets.json');
  writeFileSync(budgetsPath, JSON.stringify({
    sharedHost: { gzipBytes: 0, maxGrowthBytes: 1_000_000 },
    examples: Object.fromEntries(slugs.map((slug) => [slug, options.oversized && slug === 'gradient' ? 1 : 1_000_000])),
    exampleGrowth: { percent: 0, minimumBytes: options.oversized ? 0 : 1_000_000 },
  }));

  // Fresh by default: the source predates the chunks, as it would right after
  // a build. `staleChunks` reverses that, i.e. someone edited and did not build.
  const chunkTime = new Date('2026-01-02T00:00:00Z');
  const sourceTime = options.staleChunks
    ? new Date('2026-01-03T00:00:00Z')
    : new Date('2026-01-01T00:00:00Z');
  utimesSync(sourceFile, sourceTime, sourceTime);
  for (const name of ['host.js', ...slugs.map((slug) => `${slug}.js`)]) {
    utimesSync(path.join(chunks, name), chunkTime, chunkTime);
  }

  return { chunks, budgetsPath, source };
}

function runFixture(fixture: ReturnType<typeof writeFixture>) {
  return spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      VGPU_EXAMPLE_CHUNKS_DIR: fixture.chunks,
      VGPU_EXAMPLE_BUDGETS_FILE: fixture.budgetsPath,
      VGPU_EXAMPLE_SOURCE_DIR: fixture.source,
    },
  });
}

test('fails when one preview chunk contains another example', () => {
  const result = runFixture(writeFixture({ foreign: true }));

  expect(result.status).toBe(1);
  expect(result.stderr).toContain("contains another example's renderer/WGSL: fluid");
});

// ANCHOR TGEIST-08: same assertion as above, with the marker shape Turbopack emits while this app
// lives in `apps/docs-next`. This is the test that fails if someone reverts the script's
// `docs(?:-next)?` back to a hardcoded `apps/docs`, which would turn the isolation check into a
// no-op in this tree. It keeps passing unchanged after the TGEIST-15 rename.
test('fails when one preview chunk contains another example in the docs-next tree', () => {
  const result = runFixture(writeFixture({ foreign: true, markerRoot: 'apps/docs-next' }));

  expect(result.status).toBe(1);
  expect(result.stderr).toContain("contains another example's renderer/WGSL: fluid");
});

test('fails when one preview chunk exceeds its gzip budget', () => {
  const result = runFixture(writeFixture({ oversized: true }));

  expect(result.status).toBe(1);
  expect(result.stderr).toContain('/preview/gradient chunks are');
  expect(result.stderr).toContain('budget is 1 B');
});

test('refuses to grade chunks older than the sources they were built from', () => {
  const result = runFixture(writeFixture({ staleChunks: true }));

  expect(result.status).toBe(1);
  expect(result.stderr).toContain('Stale chunks: examples/gradient/renderer.ts');
  expect(result.stderr).toContain('pnpm --filter docs build');
});
