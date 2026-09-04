#!/usr/bin/env node
/**
 * Fails the build when an artifact-backed route loses the prebuild-generated examples tree or
 * traces an unsafe deployment bundle.
 *
 * The route handlers read the tree with `fs` at request time, so Next's static tracing cannot see
 * the path and `outputFileTracingIncludes` in `next.config.ts` is the only thing putting those
 * files in the lambda. Two ways that silently breaks, both of which have already happened:
 *
 *   - the include entry is removed or the tree moves, so nothing is bundled;
 *   - an include key stops matching its route. Keys are picomatch globs matched against the
 *     normalized app path, so a literal dynamic segment such as `[revision]` parses as a
 *     character class and matches nothing at all.
 *
 * Dynamic filesystem probes can also make Next trace unrelated public assets into each function,
 * silently crossing Vercel's standard 250 MB function limit. Local servers read the working tree
 * and mask both classes of problem, so completeness, forbidden prefixes, and size are asserted
 * against the real build output instead of trusting the config shape.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';

const appDirectory = resolve(import.meta.dirname, '..');
const treeRoot = resolve(appDirectory, 'generated/examples-api');
const serverDirectory = resolve(appDirectory, '.next/server/app');

const ROUTES = [
  '.well-known/vgpu-examples.json',
  'api/examples/v1/latest.json',
  'api/examples/v1/revisions/[revision]/[...artifact]',
  'api/mcp',
];
const MAX_TRACE_BYTES = 250_000_000;
const FORBIDDEN_APP_PREFIXES = ['public/'];

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
  const resolvedFiles = [...new Set(trace.files.map((file) => resolve(traceDirectory, file)))];
  const traced = new Set(
    resolvedFiles.map((file) => relative(treeRoot, file)).filter((file) => !file.startsWith('..')),
  );
  const missing = artifacts.filter((artifact) => !traced.has(artifact));
  if (missing.length > 0) {
    failed = true;
    console.error(
      `::error::/${route} bundles ${traced.size}/${artifacts.length} examples-api artifacts. ` +
        `Missing ${missing.length}, first: ${missing.slice(0, 3).join(', ')}. ` +
        'Check that an outputFileTracingIncludes key in apps/docs/next.config.ts still matches this route.',
    );
  } else {
    console.log(`/${route}: ${traced.size}/${artifacts.length} examples-api artifacts bundled`);
  }

  const appRelativeFiles = resolvedFiles.map((file) => relative(appDirectory, file).replaceAll('\\', '/'));
  const forbidden = appRelativeFiles.filter((file) =>
    FORBIDDEN_APP_PREFIXES.some((prefix) => file.startsWith(prefix)),
  );
  if (forbidden.length > 0) {
    failed = true;
    console.error(
      `::error::/${route} traces ${forbidden.length} unrelated public assets, first: ` +
        `${forbidden.slice(0, 3).join(', ')}. Add a route-scoped outputFileTracingExcludes entry.`,
    );
  }

  const traceBytes = (
    await Promise.all(
      resolvedFiles.map(async (file) => {
        try {
          return (await stat(file)).size;
        } catch {
          return 0;
        }
      }),
    )
  ).reduce((total, size) => total + size, 0);
  if (traceBytes > MAX_TRACE_BYTES) {
    failed = true;
    console.error(
      `::error::/${route} trace is ${traceBytes.toLocaleString('en-US')} bytes, over the ` +
        `${MAX_TRACE_BYTES.toLocaleString('en-US')}-byte standard Vercel Function limit.`,
    );
  } else {
    console.log(`/${route}: ${traceBytes.toLocaleString('en-US')} traced bytes`);
  }
}

if (failed) process.exit(1);
console.log(`All ${ROUTES.length} examples routes bundle the complete artifact tree.`);
