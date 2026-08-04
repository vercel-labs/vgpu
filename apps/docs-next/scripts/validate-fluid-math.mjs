import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const cache = path.resolve('apps/docs/.fluid-math-cache');
await mkdir(cache, { recursive: true });
const output = path.join(cache, 'math.mjs');
try {
  await build({ entryPoints: ['apps/docs/examples/fluid/math.ts'], outfile: output, bundle: true, format: 'esm', platform: 'node' });
  const { bilerp, clampedCell, fixedStepCount, idleEmitters, segmentDistance } = await import(`${pathToFileURL(output)}?${Date.now()}`);
  assert.equal(bilerp(0, 2, 4, 6, .5, .5), 3);
  assert.deepEqual(clampedCell(-3, 90), [0, 71]);
  assert.ok(Math.abs(segmentDistance([.5, .55], [.2, .5], [.8, .5]) - .05) < 1e-12);
  assert.deepEqual(fixedStepCount(0, 1), { steps: 2, accumulator: 0 });
  assert.deepEqual(idleEmitters(120), idleEmitters(120));
  for (const step of [0, 1, 120, 10_000]) for (const point of idleEmitters(step)) for (const value of point) assert.ok(value >= .2 && value <= .8);
  console.log('fluid math fixtures: PASS (bilerp, boundaries, segment, accumulator, idle schedule)');
} finally { await rm(cache, { recursive: true, force: true }); }
