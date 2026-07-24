import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
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

function writeFixture(options: { foreign?: boolean; oversized?: boolean } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'example-bundles-'));
  const chunks = path.join(root, 'chunks');
  mkdirSync(chunks);

  const loaders = slugs.map((slug, index) => {
    const property = slug.includes('-') ? JSON.stringify(slug) : slug;
    return `${property}:()=>e.A(${index + 1})`;
  }).join(',');
  const manifests = slugs.map((slug, index) => `,${index + 1},()=>Promise.all(["static/chunks/${slug}.js"].map(x=>x))`).join('');
  writeFileSync(path.join(chunks, 'host.js'), `let a={${loaders}};${manifests}`);

  for (const slug of slugs) {
    const foreignMarker = options.foreign && slug === 'gradient'
      ? 'apps/docs/examples/fluid/renderer.ts'
      : `apps/docs/examples/${slug}/renderer.ts`;
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

  return { chunks, budgetsPath };
}

function runFixture(fixture: ReturnType<typeof writeFixture>) {
  return spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      VGPU_EXAMPLE_CHUNKS_DIR: fixture.chunks,
      VGPU_EXAMPLE_BUDGETS_FILE: fixture.budgetsPath,
    },
  });
}

test('fails when one preview chunk contains another example', () => {
  const result = runFixture(writeFixture({ foreign: true }));

  expect(result.status).toBe(1);
  expect(result.stderr).toContain("contains another example's renderer/WGSL: fluid");
});

test('fails when one preview chunk exceeds its gzip budget', () => {
  const result = runFixture(writeFixture({ oversized: true }));

  expect(result.status).toBe(1);
  expect(result.stderr).toContain('/preview/gradient chunks are');
  expect(result.stderr).toContain('budget is 1 B');
});
