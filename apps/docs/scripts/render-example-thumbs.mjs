import { mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { init } from 'vgpu/node';
import { comparePngSnapshot } from '@vgpu/cli/lib/snapshot/png.js';

const docsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(docsDir, 'public', 'examples');
const cacheDir = path.join(docsDir, '.thumbs-cache');
const rendererEntry = path.join(cacheDir, 'renderers-entry.ts');
const rendererBundle = path.join(cacheDir, 'renderers.mjs');
const docsDataEntry = path.join(cacheDir, 'docs-data-entry.ts');
const docsDataBundle = path.join(cacheDir, 'docs-data.mjs');

const sizes = {
  card: [1280, 720],
  hero: [1600, 900],
};

const defaultFragmentTime = Math.PI / 4;
const minLumaVariance = 6;
const compareOptions = {
  pixelmatchThreshold: 0.1,
  maxDiffRatio: 0.02,
};

function renderFragmentThumb(gpu, target, fragmentSource, { time }) {
  const effect = gpu.effect(fragmentSource);
  const [width, height] = target.size;
  effect.set({
    uniforms: {
      time,
      resolution: [width, height],
    },
  });
  gpu.frame((frame) => frame.pass({ target }, (p) => p.draw(effect)));
}

const args = parseArgs(process.argv.slice(2));
await mkdir(outDir, { recursive: true });
const [renderers, docsData] = await Promise.all([loadRenderers(), loadDocsData()]);
const { examples, exampleSources } = docsData;

let failures = 0;
const selected = examples.filter((example) => !args.only || example.meta.slug === args.only);
if (args.only && selected.length === 0) throw new Error(`Unknown example slug '${args.only}'.`);

for (const example of selected) {
  const slug = example.meta.slug;
  const metaThumb = example.meta.thumb ?? {};
  if (metaThumb.headless === false) {
    console.log(`- ${slug}: skipped (headless:false)`);
    continue;
  }

  for (const [kind, size] of Object.entries(sizes)) {
    const output = path.join(outDir, `${slug}.${kind}.png`);
    const result = await renderOne(renderers, example, exampleSources, size, metaThumb, output);
    const status = `${result.compare.status}${result.compare.ratio ? ` (${(result.compare.ratio * 100).toFixed(3)}%)` : ''}`;
    console.log(`- ${slug}.${kind}: ${status}, variance=${result.variance.toFixed(2)}, bytes=${result.bytes}`);
    if (['missing', 'different'].includes(result.compare.status)) failures++;
  }
}

await rm(cacheDir, { recursive: true, force: true });
if ((args.check || !args.update) && failures > 0) process.exitCode = 1;

async function renderOne(renderers, example, exampleSources, size, metaThumb, output) {
  const slug = example.meta.slug;
  const gpu = await init();
  try {
    const target = gpu.target({ size, format: 'rgba8unorm', label: `docs-example-${slug}` });
    if (slug === 'triangle-led-god-rays') {
      await renderers.triangleLedGodRays(gpu, target, {
        warmupFrames: metaThumb.warmupFrames ?? 60,
        dt: metaThumb.dt ?? 1 / 60,
        time: metaThumb.time,
      });
    } else {
      const fragmentFile = resolveFragmentFile(example, exampleSources);
      if (!fragmentFile) throw new Error(`No fragment shader found for '${slug}'.`);
      const fragmentSource = sourceFor(exampleSources, slug, fragmentFile);
      renderFragmentThumb(
        gpu,
        target,
        fragmentSource,
        { time: metaThumb.time ?? defaultFragmentTime },
      );
    }
    const pixels = await target.read();
    const variance = lumaVariance(pixels);
    if (variance < minLumaVariance) throw new Error(`${slug} rendered an empty-looking thumbnail: luma variance ${variance.toFixed(2)} < ${minLumaVariance}.`);
    const compare = await comparePngSnapshot(output, pixels, size[0], size[1], { ...compareOptions, update: args.update });
    const info = await stat(output).catch(() => undefined);
    return { compare, variance, bytes: info?.size ?? 0 };
  } finally {
    gpu.dispose();
  }
}

function resolveFragmentFile(example, exampleSources) {
  const slug = example.meta.slug;
  const preferred = example.meta.thumb?.fragmentFile;
  if (preferred) return preferred;
  const metaListed = example.meta.files?.find((file) => file.endsWith('.wgsl'));
  if (metaListed) return metaListed;
  const generated = exampleSources[slug]?.find((item) => item.lang === 'wgsl');
  return generated?.name;
}

function sourceFor(exampleSources, slug, fileName) {
  const file = exampleSources[slug]?.find((item) => item.name === fileName);
  if (!file) throw new Error(`Missing generated source for ${slug}/${fileName}. Run scripts/ingest-examples.mjs first.`);
  return file.code;
}

function lumaVariance(bytes) {
  let sum = 0;
  let sumSq = 0;
  const count = bytes.length / 4;
  for (let i = 0; i < bytes.length; i += 4) {
    const y = 0.2126 * bytes[i] + 0.7152 * bytes[i + 1] + 0.0722 * bytes[i + 2];
    sum += y;
    sumSq += y * y;
  }
  const mean = sum / count;
  return sumSq / count - mean * mean;
}


async function loadRenderers() {
  await mkdir(cacheDir, { recursive: true });
  await import('node:fs/promises').then(({ writeFile }) => writeFile(rendererEntry, `
    export { renderThumb as triangleLedGodRays } from '../examples/triangle-led-god-rays/example';
  `));
  await build({
    entryPoints: [rendererEntry],
    outfile: rendererBundle,
    bundle: true,
    platform: 'node',
    format: 'esm',
    sourcemap: false,
    external: ['vgpu', 'vgpu/node'],
    loader: { '.wgsl': 'text' },
    logLevel: 'silent',
  });
  return import(pathToFileURL(rendererBundle).href);
}

async function loadDocsData() {
  await mkdir(cacheDir, { recursive: true });
  await import('node:fs/promises').then(({ writeFile }) => writeFile(docsDataEntry, `
    export { examples } from '../lib/examples-registry';
    export { exampleSources } from '../lib/examples-source.generated';
  `));
  await build({
    entryPoints: [docsDataEntry],
    outfile: docsDataBundle,
    bundle: true,
    platform: 'node',
    format: 'esm',
    sourcemap: false,
    external: ['server-only'],
    loader: { '.wgsl': 'text' },
    logLevel: 'silent',
  });
  return import(pathToFileURL(docsDataBundle).href);
}

function parseArgs(argv) {
  const parsed = { update: false, check: false, only: undefined };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') continue;
    else if (arg === '--update') parsed.update = true;
    else if (arg === '--check') parsed.check = true;
    else if (arg === '--only') parsed.only = argv[++i];
    else throw new Error(`Unknown argument '${arg}'.`);
  }
  if (parsed.update && parsed.check) throw new Error('Use either --update or --check, not both.');
  return parsed;
}
