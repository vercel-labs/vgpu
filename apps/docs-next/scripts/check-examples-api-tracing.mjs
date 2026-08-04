#!/usr/bin/env node
/**
 * Fails the build when the generated examples-api tree is not bundled into every examples route.
 *
 * The route handlers read the tree with `fs` at request time, so Next's static tracing cannot see
 * the path and `outputFileTracingIncludes` in `next.config.mjs` is the only thing putting those
 * files in the lambda. Two ways that silently breaks, both of which have already happened:
 *
 *   - the include entry is removed or the tree moves, so nothing is bundled;
 *   - an include key stops matching its route. Keys are picomatch globs matched against the
 *     normalized app path, so a literal dynamic segment such as `[revision]` parses as a
 *     character class and matches nothing at all.
 *
 * Either way every local test still passes -- `next dev` and `next start` read the working tree,
 * never the bundle -- and the failure only appears in production as a 404 on the CLI's very first
 * request. So it is asserted against the real build output instead of trusted.
 */
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';

const appDirectory = resolve(import.meta.dirname, '..');
const treeRoot = resolve(appDirectory, 'generated/examples-api');
const serverDirectory = resolve(appDirectory, '.next/server/app');

const ROUTES = [
  '.well-known/vgpu-examples.json',
  'api/examples/v1/latest.json',
  'api/examples/v1/revisions/[revision]/[...artifact]',
];

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? walk(path) : [path];
    }),
  );
  return files.flat();
}

const artifacts = (await walk(treeRoot)).map((path) => relative(treeRoot, path)).sort();
if (artifacts.length === 0) {
  console.error('::error::No generated examples-api artifacts found. Run node apps/docs/scripts/generate-examples-api.mjs.');
  process.exit(1);
}

let failed = false;
for (const route of ROUTES) {
  const tracePath = resolve(serverDirectory, route, 'route.js.nft.json');
  let trace;
  try {
    trace = JSON.parse(await readFile(tracePath, 'utf8'));
  } catch {
    console.error(`::error::Missing file trace for /${route}. Build the docs app before running this check.`);
    failed = true;
    continue;
  }
  const traceDirectory = dirname(tracePath);
  const traced = new Set(
    trace.files.map((file) => relative(treeRoot, resolve(traceDirectory, file))).filter((file) => !file.startsWith('..')),
  );
  const missing = artifacts.filter((artifact) => !traced.has(artifact));
  if (missing.length > 0) {
    failed = true;
    console.error(
      `::error::/${route} bundles ${traced.size}/${artifacts.length} examples-api artifacts. ` +
        `Missing ${missing.length}, first: ${missing.slice(0, 3).join(', ')}. ` +
        'Check that an outputFileTracingIncludes key in apps/docs/next.config.mjs still matches this route.',
    );
  } else {
    console.log(`/${route}: ${traced.size}/${artifacts.length} examples-api artifacts bundled`);
  }
}

if (failed) process.exit(1);
console.log(`All ${ROUTES.length} examples routes bundle the complete artifact tree.`);
