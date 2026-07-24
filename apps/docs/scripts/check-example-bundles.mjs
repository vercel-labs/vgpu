import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const docsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const chunksDir = process.env.VGPU_EXAMPLE_CHUNKS_DIR
  ? path.resolve(process.env.VGPU_EXAMPLE_CHUNKS_DIR)
  : path.join(docsDir, '.next', 'static', 'chunks');
const budgetsFile = process.env.VGPU_EXAMPLE_BUDGETS_FILE
  ? path.resolve(process.env.VGPU_EXAMPLE_BUDGETS_FILE)
  : new URL('./example-chunk-budgets.json', import.meta.url);
const budgets = JSON.parse(await readFile(budgetsFile, 'utf8'));
const slugs = Object.keys(budgets.examples);

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
for (const name of names) {
  chunkSources.set(name, await readFile(path.join(chunksDir, name)));
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
    const owner = chunkOwners.get(chunk);
    if (owner && owner !== slug) throw new Error(`${chunk} is shared by ${owner} and ${slug}; example chunks must be isolated.`);
    chunkOwners.set(chunk, slug);

    const markerSlugs = new Set([...source.toString('utf8').matchAll(/apps\/docs\/examples\/([a-z0-9-]+)\//g)].map((match) => match[1]));
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
