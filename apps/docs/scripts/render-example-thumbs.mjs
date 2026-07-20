import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { init } from 'vgpu/node';
import { comparePngSnapshot, writePng } from '@vgpu/cli/lib/snapshot/png.js';
import { transformWgsl } from '@vgpu/wgsl/loader-vite';

const docsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(docsDir, 'public', 'examples');
const cacheDir = path.join(docsDir, '.thumbs-cache');
const rendererEntry = path.join(cacheDir, 'renderers-entry.ts');
const rendererBundle = path.join(cacheDir, 'renderers.mjs');
const docsDataEntry = path.join(cacheDir, 'docs-data-entry.ts');
const docsDataBundle = path.join(cacheDir, 'docs-data.mjs');

/** @typedef {{ slug: string; module: string; exportName: string }} CustomRendererEntry */
/** @type {CustomRendererEntry[]} */
const customRendererEntries = [
  { slug: 'triangle-led-front', module: '../examples/triangle-led-front/example.ts', exportName: 'renderThumb' },
  { slug: 'anti-aliasing', module: '../examples/anti-aliasing/example.ts', exportName: 'renderThumb' },
  { slug: 'post-processing', module: '../examples/post-processing/example.ts', exportName: 'renderThumb' },
  { slug: 'fluid', module: '../examples/fluid/validation.ts', exportName: 'renderThumb' },
];

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
const aaModeNames = new Map([[0, 'off'], [1, 'msaa-4x'], [2, 'ssaa-2x'], [3, 'fxaa']]);

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

  const selectedSizes = args.fluidSoak && slug === 'fluid' ? { card: sizes.card } : sizes;
  for (const [kind, size] of Object.entries(selectedSizes)) {
    const output = path.join(outDir, `${slug}.${kind}.png`);
    const result = await renderOne(renderers, example, exampleSources, size, metaThumb, output);
    const status = `${result.compare.status}${result.compare.ratio ? ` (${(result.compare.ratio * 100).toFixed(3)}%)` : ''}`;
    console.log(`- ${slug}.${kind}: ${status}, variance=${result.variance.toFixed(2)}, bytes=${result.bytes}${result.aaMetrics ? `, ${formatAaMetrics(result.aaMetrics)}` : ''}${result.fluidMetrics ? `, fluid=${JSON.stringify(result.fluidMetrics)}` : ''}${result.fluidState ? `, state=${JSON.stringify(result.fluidState)}` : ''}`);
    if (args.fluidSoak && slug === 'fluid') {
      // State checkpoints are asserted by onStateValidated; the soak image is diagnostic only.
    } else if (args.fluidDrag && slug === 'fluid') {
      if ((result.compare.ratio ?? 0) < .08) throw new Error(`Fluid scripted drag changed only ${((result.compare.ratio ?? 0) * 100).toFixed(2)}% of pixels; need >=8%.`);
    } else if (['missing', 'different'].includes(result.compare.status)) failures++;
  }
}

await rm(cacheDir, { recursive: true, force: true });
if ((args.check || !args.update) && failures > 0) process.exitCode = 1;

async function renderOne(renderers, example, exampleSources, size, metaThumb, output) {
  const slug = example.meta.slug;
  const gpu = await init();
  try {
    const target = gpu.target({ size, format: 'rgba8unorm', label: `docs-example-${slug}` });
    const renderer = renderers[slug];
    const aaModePixels = slug === 'anti-aliasing' ? new Map() : undefined;
    let fluidState;
    if (renderer) {
      await renderer(gpu, target, {
        warmupFrames: metaThumb.warmupFrames ?? 60,
        dt: metaThumb.dt ?? 1 / 60,
        time: metaThumb.time,
        onModeRendered: aaModePixels
          ? (mode, pixels) => aaModePixels.set(mode, pixels.slice())
          : undefined,
        scriptedDrag: slug === 'fluid' && args.fluidDrag,
        soak: slug === 'fluid' && args.fluidSoak,
        onStateValidated: slug === 'fluid' ? (stats) => { assertFluidState(stats); fluidState = stats; } : undefined,
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
    const aaMetrics = aaModePixels ? assertAaMetrics(aaModePixels, size[0], size[1]) : undefined;
    const fluidMetrics = slug === 'fluid' && !args.fluidSoak ? assertFluidMetrics(pixels, size[0], size[1]) : undefined;
    if (aaModePixels && process.env.VGPU_AA_MODE_OUTPUT_DIR) {
      await writeAaModePngs(aaModePixels, size, path.basename(output, '.png').replace('anti-aliasing.', ''));
    }
    const variance = lumaVariance(pixels);
    const requiredVariance = slug === 'fluid' ? 120 : minLumaVariance;
    if (variance < requiredVariance) throw new Error(`${slug} rendered an empty-looking thumbnail: luma variance ${variance.toFixed(2)} < ${requiredVariance}.`);
    const diagnosticMode = args.fluidDrag || args.fluidSoak;
    const compare = await comparePngSnapshot(output, pixels, size[0], size[1], { ...compareOptions, update: args.update && !diagnosticMode });
    const info = await stat(output).catch(() => undefined);
    return { compare, variance, bytes: info?.size ?? 0, aaMetrics, fluidMetrics, fluidState };
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

function assertFluidState(stats) {
  if (!stats.finite) throw new Error(`Fluid state contains NaN/Infinity after ${stats.steps} steps.`);
  if (stats.maxSpeed > 2.5001) throw new Error(`Fluid speed ${stats.maxSpeed} exceeds 2.5001 after ${stats.steps} steps.`);
  if (stats.maxDye > 4.0001) throw new Error(`Fluid dye ${stats.maxDye} exceeds 4.0001 after ${stats.steps} steps.`);
  if (stats.steps >= 120 && (stats.averageDye < .01 || stats.averageDye > 2.5)) throw new Error(`Fluid average dye ${stats.averageDye} is outside [.01, 2.5].`);
}

function assertFluidMetrics(pixels, width, height) {
  let background = 0, cyan = 0, magenta = 0, clipped = 0;
  const count = pixels.length / 4;
  for (let i = 0; i < pixels.length; i += 4) {
    const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
    const bright = Math.max(r, g, b) > 18;
    if (!bright) background++;
    if (b > r * 1.12 && (g > r || b > 80)) cyan++;
    if (r > g * 1.2 && b > g * 1.08 && r > 60) magenta++;
    if (r >= 254 || g >= 254 || b >= 254) clipped++;
  }
  const metrics = { coverage: 1 - background / count, cyan: cyan / count, magenta: magenta / count, clipped: clipped / count };
  const problems = [];
  if (metrics.coverage < .15 || metrics.coverage > .70) problems.push(`coverage ${(metrics.coverage * 100).toFixed(1)}% (need 15–70%)`);
  if (metrics.cyan < .05) problems.push(`cyan ${(metrics.cyan * 100).toFixed(1)}% (need >=5%)`);
  if (metrics.magenta < .03) problems.push(`magenta/coral ${(metrics.magenta * 100).toFixed(1)}% (need >=3%)`);
  if (metrics.clipped > .02) problems.push(`clipped ${(metrics.clipped * 100).toFixed(1)}% (need <=2%)`);
  if (problems.length) throw new Error(`Fluid poster validation failed (${width}x${height}):\n${problems.map((x) => `- ${x}`).join('\n')}`);
  return metrics;
}

function assertAaMetrics(modePixels, width, height) {
  for (const mode of aaModeNames.keys()) {
    if (!modePixels.has(mode)) throw new Error(`Anti-aliasing validation did not capture mode ${mode}.`);
  }
  const off = modePixels.get(0);
  const edgeMask = dilatedEdgeMask(off, width, height);
  const msaa = compareAaPair(off, modePixels.get(1), edgeMask);
  const ssaa = compareAaPair(off, modePixels.get(2), edgeMask);
  const fxaa = compareAaPair(off, modePixels.get(3), edgeMask);
  const silhouette = silhouetteDice(off, modePixels.get(2));
  const metrics = { msaa, ssaa, fxaa, silhouette };

  const problems = [];
  if (msaa.diffRatio <= 0.003) problems.push(`Off/MSAA changed only ${(msaa.diffRatio * 100).toFixed(3)}% of pixels (need >0.300%)`);
  if (msaa.edgeConcentration < 0.8) problems.push(`Off/MSAA edge concentration ${(msaa.edgeConcentration * 100).toFixed(1)}% (need >=80%)`);
  if (silhouette < 0.95) problems.push(`Off/SSAA silhouette Dice ${(silhouette * 100).toFixed(2)}% (need >=95%)`);
  if (ssaa.diffRatio <= 0.003) problems.push(`Off/SSAA changed only ${(ssaa.diffRatio * 100).toFixed(3)}% of pixels (need >0.300%)`);
  if (ssaa.edgeConcentration < 0.75) problems.push(`Off/SSAA edge concentration ${(ssaa.edgeConcentration * 100).toFixed(1)}% (need >=75%)`);
  if (fxaa.diffRatio <= 0.003) problems.push(`Off/FXAA changed only ${(fxaa.diffRatio * 100).toFixed(3)}% of pixels (need >0.300%)`);
  if (fxaa.edgeConcentration < 0.7) problems.push(`Off/FXAA edge concentration ${(fxaa.edgeConcentration * 100).toFixed(1)}% (need >=70%)`);
  if (problems.length) throw new Error([
    `Anti-aliasing semantic validation failed (${width}x${height}):`,
    ...problems.map((problem) => `- ${problem}`),
    'Run pnpm thumbs:docker -- --only anti-aliasing and inspect the per-mode captures.',
  ].join('\n'));
  return metrics;
}

function compareAaPair(a, b, edgeMask) {
  let changed = 0;
  let changedOnEdge = 0;
  const count = a.length / 4;
  for (let pixel = 0; pixel < count; pixel++) {
    const i = pixel * 4;
    const delta = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]));
    if (delta < 8) continue;
    changed++;
    if (edgeMask[pixel]) changedOnEdge++;
  }
  return { diffRatio: changed / count, edgeConcentration: changed ? changedOnEdge / changed : 0 };
}

function dilatedEdgeMask(bytes, width, height) {
  const luma = new Float32Array(width * height);
  for (let pixel = 0; pixel < luma.length; pixel++) {
    const i = pixel * 4;
    luma[pixel] = 0.2126 * bytes[i] + 0.7152 * bytes[i + 1] + 0.0722 * bytes[i + 2];
  }
  const edges = new Uint8Array(luma.length);
  for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
    const i = y * width + x;
    const delta = Math.max(Math.abs(luma[i] - luma[i - 1]), Math.abs(luma[i] - luma[i + 1]), Math.abs(luma[i] - luma[i - width]), Math.abs(luma[i] - luma[i + width]));
    if (delta >= 20) edges[i] = 1;
  }
  const dilated = new Uint8Array(edges.length);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    for (let oy = -2; oy <= 2 && !dilated[y * width + x]; oy++) for (let ox = -2; ox <= 2; ox++) {
      const sx = x + ox;
      const sy = y + oy;
      if (sx >= 0 && sx < width && sy >= 0 && sy < height && edges[sy * width + sx]) { dilated[y * width + x] = 1; break; }
    }
  }
  return dilated;
}

function silhouetteDice(a, b) {
  let intersection = 0;
  let total = 0;
  for (let i = 0; i < a.length; i += 4) {
    const aOn = 0.2126 * a[i] + 0.7152 * a[i + 1] + 0.0722 * a[i + 2] >= 64;
    const bOn = 0.2126 * b[i] + 0.7152 * b[i + 1] + 0.0722 * b[i + 2] >= 64;
    if (aOn) total++;
    if (bOn) total++;
    if (aOn && bOn) intersection++;
  }
  return total ? (2 * intersection) / total : 1;
}

function formatAaMetrics(metrics) {
  const pair = (name, value) => `${name} diff=${(value.diffRatio * 100).toFixed(3)}% edge=${(value.edgeConcentration * 100).toFixed(1)}%`;
  return `${pair('MSAA', metrics.msaa)}, ${pair('SSAA', metrics.ssaa)}, silhouette=${(metrics.silhouette * 100).toFixed(2)}%, ${pair('FXAA', metrics.fxaa)}`;
}

async function writeAaModePngs(modePixels, size, kind) {
  const dir = process.env.VGPU_AA_MODE_OUTPUT_DIR;
  await mkdir(dir, { recursive: true });
  await Promise.all([...aaModeNames].map(([mode, name]) => writePng(path.join(dir, `${kind}-${name}.png`), modePixels.get(mode), size[0], size[1])));
}

async function loadRenderers() {
  if (customRendererEntries.length === 0) return {};
  await mkdir(cacheDir, { recursive: true });
  const contents = customRendererEntries
    .map((entry, index) => `export { ${entry.exportName} as renderer_${index} } from '${entry.module}';`)
    .join('\n');
  await import('node:fs/promises').then(({ writeFile }) => writeFile(rendererEntry, `${contents}\n`));
  await build({
    entryPoints: [rendererEntry],
    outfile: rendererBundle,
    bundle: true,
    platform: 'node',
    format: 'esm',
    sourcemap: false,
    external: ['vgpu', 'vgpu/node'],
    plugins: [wgslPlugin()],
    logLevel: 'silent',
  });
  const module = await import(pathToFileURL(rendererBundle).href);
  return customRendererEntries.reduce((acc, entry, index) => {
    const renderer = module[`renderer_${index}`];
    if (typeof renderer !== 'function') {
      throw new Error(`Renderer export for '${entry.slug}' was not found.`);
    }
    acc[entry.slug] = renderer;
    return acc;
  }, /** @type {Record<string, Function>} */ ({}));
}

function wgslPlugin() {
  return {
    name: 'docs-wgsl',
    setup(build) {
      build.onLoad({ filter: /\.wgsl$/ }, async (args) => {
        const source = await readFile(args.path, 'utf8');
        const result = await transformWgsl({ source, id: args.path });
        return { contents: result.code, loader: 'js', resolveDir: path.dirname(args.path) };
      });
    },
  };
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
  const parsed = { update: false, check: false, only: undefined, fluidDrag: false, fluidSoak: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') continue;
    else if (arg === '--update') parsed.update = true;
    else if (arg === '--check') parsed.check = true;
    else if (arg === '--only') parsed.only = argv[++i];
    else if (arg === '--fluid-drag') parsed.fluidDrag = true;
    else if (arg === '--fluid-soak') parsed.fluidSoak = true;
    else throw new Error(`Unknown argument '${arg}'.`);
  }
  if (parsed.update && parsed.check) throw new Error('Use either --update or --check, not both.');
  return parsed;
}
