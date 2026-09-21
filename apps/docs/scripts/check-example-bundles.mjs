import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const docsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const chunksDir = process.env.VGPU_EXAMPLE_CHUNKS_DIR
  ? path.resolve(process.env.VGPU_EXAMPLE_CHUNKS_DIR)
  : path.join(docsDir, '.next', 'static', 'chunks');
const sourceDir = process.env.VGPU_EXAMPLE_SOURCE_DIR
  ? path.resolve(process.env.VGPU_EXAMPLE_SOURCE_DIR)
  : docsDir;

/**
 * Everything that can change what lands in an example chunk. Deliberately not
 * the whole app: `.next`, `node_modules` and `public` are outputs or assets,
 * and walking them would cost more than the check is worth.
 */
const SOURCE_ROOTS = ['app', 'components', 'examples', 'lib', 'next.config.mjs', 'package.json'];

/** Newest mtime under `entry`, or 0 if it does not exist. */
async function newestMtime(entry) {
  const info = await stat(entry).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (!info) return { time: 0, file: null };
  if (!info.isDirectory()) return { time: info.mtimeMs, file: entry };

  let newest = { time: 0, file: null };
  for (const child of await readdir(entry, { withFileTypes: true })) {
    if (child.name === 'node_modules' || child.name.startsWith('.')) continue;
    const found = await newestMtime(path.join(entry, child.name));
    if (found.time > newest.time) newest = found;
  }
  return newest;
}
const budgetsFile = process.env.VGPU_EXAMPLE_BUDGETS_FILE
  ? path.resolve(process.env.VGPU_EXAMPLE_BUDGETS_FILE)
  : new URL('./example-chunk-budgets.json', import.meta.url);
const budgets = JSON.parse(await readFile(budgetsFile, 'utf8'));
const slugs = Object.keys(budgets.examples);
const slugSource = await readFile(path.join(sourceDir, 'lib', 'example-slugs.ts'), 'utf8');
const slugTuple = slugSource.match(/export const exampleSlugs\s*=\s*\[([\s\S]*?)\]\s*as const/u)?.[1];
if (!slugTuple) throw new Error('Could not parse the canonical exampleSlugs tuple.');
const canonicalSlugs = [...slugTuple.matchAll(/(['"])(.*?)\1/gu)].map((match) => match[2]);
const missingBudgets = canonicalSlugs.filter((slug) => !slugs.includes(slug));
const staleBudgets = slugs.filter((slug) => !canonicalSlugs.includes(slug));
if (missingBudgets.length || staleBudgets.length) {
  throw new Error(
    `Example budget coverage must exactly match exampleSlugs. Missing: ${missingBudgets.join(', ') || 'none'}. `
    + `Stale: ${staleBudgets.join(', ') || 'none'}.`,
  );
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function gzipBytes(source) {
  return gzipSync(source).byteLength;
}

const names = (await readdir(chunksDir).catch((error) => {
  if (error?.code === 'ENOENT') {
    throw new Error('Missing .next production chunks. Run `pnpm --filter docs build` before this check.');
  }
  throw error;
})).filter((name) => name.endsWith('.js'));

const chunkSources = new Map();
let newestChunk = 0;
for (const name of names) {
  const file = path.join(chunksDir, name);
  chunkSources.set(name, await readFile(file));
  newestChunk = Math.max(newestChunk, (await stat(file)).mtimeMs);
}

/**
 * This script measures whatever chunks it finds and never builds anything, so
 * without this it will happily grade a build from last week and report a pass.
 * That is not hypothetical: the ML baselines in the budgets file were all
 * captured that way and two of them were wrong by up to 57%.
 */
const newestSource = (await Promise.all(SOURCE_ROOTS.map((root) => newestMtime(path.join(sourceDir, root)))))
  .reduce((newest, found) => (found.time > newest.time ? found : newest), { time: 0, file: null });
if (newestSource.time > newestChunk) {
  throw new Error(
    `Stale chunks: ${path.relative(sourceDir, newestSource.file)} was modified at `
    + `${new Date(newestSource.time).toISOString()}, after the newest chunk in ${chunksDir} `
    + `(${new Date(newestChunk).toISOString()}). Run \`pnpm --filter docs build\` first; these numbers would describe a build that no longer exists.`,
  );
}

function loaderPattern(slug) {
  const property = slug.includes('-') ? JSON.stringify(slug) : slug;
  return new RegExp(`${escapeRegExp(property)}:\\(\\)=>[$\\w]+\\.A\\((\\d+)\\)`);
}

const hostCandidates = [...chunkSources].filter(([, source]) => {
  const text = source.toString('utf8');
  return text.includes('Promise.all') && slugs.every((slug) => loaderPattern(slug).test(text));
});
if (hostCandidates.length !== 1) {
  throw new Error(`Expected one shared preview host chunk, found ${hostCandidates.length}.`);
}

const [hostName, hostSource] = hostCandidates[0];
const hostText = hostSource.toString('utf8');
const hostGzip = gzipBytes(hostSource);
const hostLimit = budgets.sharedHost.gzipBytes + budgets.sharedHost.maxGrowthBytes;
if (hostGzip > hostLimit) {
  throw new Error(`Shared preview host is ${hostGzip} B gzip; budget is ${hostLimit} B (${budgets.sharedHost.gzipBytes} B baseline + ${budgets.sharedHost.maxGrowthBytes} B growth).`);
}

/*
 * Turbopack preserves `apps/docs/examples/<slug>/` virtual paths for inlined
 * WGSL, but not for ordinary TypeScript modules. The marker check below is
 * therefore supplementary evidence only: it catches a foreign renderer/WGSL
 * when that path survives minification, but cannot prove source isolation for
 * examples whose chunks contain no such marker (including the current ML
 * routes). Unique route-owned chunks are still enforced above; use a bundler
 * manifest with module-to-chunk attribution before treating this as a complete
 * cross-contamination guarantee.
 */
const chunkOwners = new Map();
const results = [];
for (const slug of slugs) {
  const property = slug.includes('-') ? JSON.stringify(slug) : slug;
  const loaderMatch = hostText.match(new RegExp(`${escapeRegExp(property)}:\\(\\)=>[$\\w]+\\.A\\((\\d+)\\)`));
  if (!loaderMatch) throw new Error(`Could not find the ${slug} lazy loader in ${hostName}.`);

  const moduleId = loaderMatch[1];
  const chunkMatch = hostText.match(new RegExp(`(?:^|,)${moduleId},[\\s\\S]{0,2000}?Promise\\.all\\((\\[[^\\]]*\\])\\.map`));
  if (!chunkMatch) throw new Error(`Could not resolve production chunks for /preview/${slug} (module ${moduleId}).`);

  const chunks = JSON.parse(chunkMatch[1]).map((name) => name.replace(/^static\/chunks\//, ''));
  if (chunks.length === 0) throw new Error(`/preview/${slug} has no example chunk.`);

  let raw = 0;
  let gzip = 0;
  for (const chunk of chunks) {
    const source = chunkSources.get(chunk);
    if (!source) throw new Error(`/preview/${slug} references missing chunk ${chunk}.`);
    // ANCHOR TGEIST-08: `docs(?:-next)?` is the ONLY edit this transplant makes to this script, and
    // it is what keeps the isolation assertion from silently becoming a no-op during the dual-run
    // window. Turbopack bakes the app-relative source path of inlined WGSL into the chunk, so in
    // `apps/docs-next` the markers read `apps/docs-next/examples/<slug>/`. Measured on this build:
    // 11 example slugs still carry markers (agent-radiance-cascades, earth, environment-map,
    // fft-ocean, fft-ocean-surface, fluid, glass-fractal, optimized-black-hole,
    // radiance-cascades, transmission, triangle-led-front) and the hardcoded
    // `apps/docs/examples/` pattern matched exactly ZERO of them -- both the foreign-renderer check
    // and the `chunkOwners` shared-chunk check below are gated on `markerSlugs`, so they would have
    // passed vacuously on every build until cutover. The check itself is unchanged (same markers,
    // same comparisons, same failures); only the directory the app happens to live in is now
    // allowed to be either name, so this keeps working verbatim when TGEIST-15 renames
    // `apps/docs-next` back to `apps/docs`.
    const markerSlugs = new Set([...source.toString('utf8').matchAll(/apps\/docs(?:-next)?\/examples\/([a-z0-9-]+)\//g)].map((match) => match[1]));
    // Turbopack may factor shared library code into a dependency chunk referenced by several lazy
    // routes. Only chunks containing example source must have exactly one example owner.
    if (markerSlugs.size > 0) {
      const owner = chunkOwners.get(chunk);
      if (owner && owner !== slug) throw new Error(`${chunk} is shared by ${owner} and ${slug}; example chunks must be isolated.`);
      chunkOwners.set(chunk, slug);
    }
    const foreign = [...markerSlugs].filter((marker) => marker !== slug);
    if (foreign.length) throw new Error(`/preview/${slug} chunk ${chunk} contains another example's renderer/WGSL: ${foreign.join(', ')}.`);

    raw += source.byteLength;
    gzip += gzipBytes(source);
  }

  const baseline = budgets.examples[slug];
  const allowedGrowth = Math.max(
    budgets.exampleGrowth.minimumBytes,
    Math.ceil(baseline * budgets.exampleGrowth.percent / 100),
  );
  const limit = baseline + allowedGrowth;
  if (gzip > limit) throw new Error(`/preview/${slug} chunks are ${gzip} B gzip; budget is ${limit} B (${baseline} B baseline + ${allowedGrowth} B growth).`);
  results.push({ slug, chunks, raw, gzip, baseline, limit });
}

console.log(`shared-preview-host ${hostName}: ${hostGzip} B gzip (baseline ${budgets.sharedHost.gzipBytes} B, limit ${hostLimit} B)`);
for (const result of results) {
  console.log(`${result.slug}: ${result.gzip} B gzip / ${result.raw} B raw (baseline ${result.baseline} B, limit ${result.limit} B; chunks ${result.chunks.join(', ')})`);
}
console.log(`Example bundle isolation and budgets passed for ${results.length} preview routes.`);
