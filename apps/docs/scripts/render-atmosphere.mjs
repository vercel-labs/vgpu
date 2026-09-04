// Headless renders of the atmosphere example for visual verification.
//   node scripts/render-atmosphere.mjs [--out dir] [--preset name|all] [--size WxH] [--debug transmittance|multiscatter|sky-view|weather|terrain] [--bench N] [--accumulate N]
//   temporal stability: --temporal N [--region x,y,w,h] [--jump frame:override=value]  (e.g. --jump 40:altitude=0.4)
//   continuous change:  --temporal N --sweep override=from..to [--every K]  (e.g. --sweep altitude=0.08..2): every K-th
//                       frame is saved next to a converged still of the same state and their difference image
//   overrides: --sun <deg> --azimuth <deg> --altitude <km> --yaw <deg> --pitch <deg> --ev <stops> --haze <x> --coverage <0..1> --detail <x> --type <-1..1> --seed <n> --time <s> --tonemap agx|aces|neutral|none
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { frame, init, target as createTarget } from 'vgpu/node';
import { writePng } from '@vgpu/cli/lib/snapshot/png.js';
import { transformWgsl } from '@vgpu/wgsl/loader-vite';

const docsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = parseArgs(process.argv.slice(2));
const outDir = path.resolve(args.out ?? path.join(docsDir, '..', '..', 'artifacts', 'atmosphere'));
const cacheDir = path.join(docsDir, '.atmosphere-cache');
const entry = path.join(cacheDir, 'entry.ts');
const bundle = path.join(cacheDir, 'atmosphere.mjs');

await mkdir(cacheDir, { recursive: true });
await writeFile(entry, "export { renderStill, createGraph, applyState, bakeLuts, renderGraph } from '../examples/atmosphere/renderer.ts';\nexport { PRESETS } from '../examples/atmosphere/tuning.ts';\n");
await build({ entryPoints: [entry], outfile: bundle, bundle: true, platform: 'node', format: 'esm', sourcemap: false, external: ['vgpu', 'vgpu/node'], plugins: [wgslPlugin()], logLevel: 'silent' });
const { renderStill, createGraph, applyState, bakeLuts, renderGraph, PRESETS } = await import(pathToFileURL(bundle).href);
await rm(cacheDir, { recursive: true, force: true });

const size = args.size ?? [960, 540];
const presetNames = args.preset === 'all' || !args.preset ? Object.keys(PRESETS) : [args.preset];
await mkdir(outDir, { recursive: true });
for (const name of presetNames) {
  const base = PRESETS[name];
  if (!base) throw new Error(`Unknown preset '${name}'. Known: ${Object.keys(PRESETS).join(', ')}`);
  const state = { ...base, ...args.overrides };
  const gpu = await init();
  try {
    const target = createTarget(gpu, { size, format: 'rgba8unorm', label: `atmosphere-${name}` });
    if (args.bench) {
      console.log(`- ${name}: ${await bench(gpu, target, state, args.bench)}`);
      continue;
    }
    if (args.temporal) {
      await temporal(gpu, target, state, name, args);
      continue;
    }
    const started = performance.now();
    if (args.accumulate) await renderAccumulated(gpu, target, state, args.accumulate);
    else await renderStill(gpu, target, state, args.debug);
    const pixels = await target.read();
    const suffix = args.debug ? `.${args.debug}` : '';
    const file = path.join(outDir, `${name}${suffix}.png`);
    await writePng(file, pixels, size[0], size[1]);
    console.log(`- ${name}${suffix}: ${path.relative(process.cwd(), file)} (${(performance.now() - started).toFixed(0)} ms) ${describe(pixels, size)}`);
  } finally {
    gpu.dispose();
  }
}

/** Live-loop path: history accumulation with jitter over `frames` frames, as the browser example renders it. */
async function renderAccumulated(gpu, target, state, frames) {
  const graph = await createGraph(gpu, target, 'atmosphere-accumulate');
  graph.accumulate = true;
  applyState(graph, state, target.size);
  bakeLuts(gpu, graph);
  for (let i = 0; i < frames; i++) frame(gpu, (current) => renderGraph(current, graph, target));
  await gpu.gpu.queue.onSubmittedWorkDone();
}

/**
 * Live-loop frames at a fixed state (wind frozen), measuring how much the image changes from one frame to the next:
 * mean absolute sRGB difference (0..255) over the whole frame and over `--region x,y,w,h`, plus the temporal noise
 * of the region over the last 8 frames (mean per-pixel standard deviation). A converged temporal scheme tends to
 * zero; `--jump frame:override=value` changes the state at that frame to measure the transient and its recovery.
 */
async function temporal(gpu, target, state, name, args) {
  const graph = await createGraph(gpu, target, 'atmosphere-temporal');
  graph.accumulate = true;
  applyState(graph, state, target.size);
  bakeLuts(gpu, graph);
  const [width, height] = target.size;
  const region = args.region ?? [0, 0, width, height];
  const whole = [0, 0, width, height];
  const jump = args.jump;
  const sweep = args.sweep;
  const keep = [0, jump ? jump.frame - 1 : -1, jump ? jump.frame : -1, jump ? jump.frame + 1 : -1, args.temporal - 1];
  const recent = [];
  let previous;
  const stateAt = (i) => {
    if (sweep) {
      // Altitude sweeps geometrically like the slider; everything else linearly.
      const t = i / Math.max(1, args.temporal - 1);
      const value = sweep.key === 'altitudeKm' ? sweep.from * Math.pow(sweep.to / sweep.from, t) : sweep.from + (sweep.to - sweep.from) * t;
      return { ...state, [sweep.key]: value };
    }
    return jump && i >= jump.frame ? { ...state, ...jump.overrides } : state;
  };
  console.log(`- ${name}: temporal stability over ${args.temporal} frames at ${width}x${height}, region ${region.join(',')}${jump ? `, jump at frame ${jump.frame}: ${JSON.stringify(jump.overrides)}` : ''}${sweep ? `, sweep ${sweep.key} ${sweep.from} -> ${sweep.to}` : ''}`);
  console.log(sweep ? '  frame     value  mad(all)  mad(region)  ghost(all)  ghost(region)' : '  frame  mad(all)  mad(region)  noise(region)');
  for (let i = 0; i < args.temporal; i++) {
    const current = stateAt(i);
    applyState(graph, current, target.size);
    frame(gpu, (f) => renderGraph(f, graph, target));
    await gpu.gpu.queue.onSubmittedWorkDone();
    const pixels = await target.read();
    recent.push(pixels);
    if (recent.length > 8) recent.shift();
    if (sweep) {
      // Every K-th frame: the live frame against a converged still of the same state; the difference is the ghost.
      if (i % (args.every ?? 8) === 0 || i === args.temporal - 1) {
        const referenceTarget = createTarget(gpu, { size: target.size, format: 'rgba8unorm', label: 'atmosphere-reference' });
        await renderStill(gpu, referenceTarget, current);
        const reference = await referenceTarget.read();
        referenceTarget.color.destroy();
        const tag = `${name}.sweep.${String(i).padStart(3, '0')}`;
        await writePng(path.join(outDir, `${tag}.png`), pixels, width, height);
        await writePng(path.join(outDir, `${tag}.reference.png`), reference, width, height);
        await writePng(path.join(outDir, `${tag}.diff.png`), diffImage(pixels, reference), width, height);
        console.log(`  ${String(i).padStart(5)}  ${current[sweep.key].toFixed(3).padStart(8)}  ${(previous ? meanAbsDiff(previous, pixels, width, whole) : 0).toFixed(2).padStart(8)}  ${(previous ? meanAbsDiff(previous, pixels, width, region) : 0).toFixed(2).padStart(11)}  ${meanAbsDiff(pixels, reference, width, whole).toFixed(2).padStart(10)}  ${meanAbsDiff(pixels, reference, width, region).toFixed(2).padStart(13)}`);
      }
    } else if (previous) {
      const noise = recent.length === 8 ? temporalNoise(recent, width, region).toFixed(2) : '   -';
      console.log(`  ${String(i).padStart(5)}  ${meanAbsDiff(previous, pixels, width, whole).toFixed(2).padStart(8)}  ${meanAbsDiff(previous, pixels, width, region).toFixed(2).padStart(11)}  ${String(noise).padStart(13)}`);
    }
    previous = pixels;
    if (!sweep && keep.includes(i)) await writePng(path.join(outDir, `${name}.temporal.${String(i).padStart(3, '0')}.png`), pixels, width, height);
  }
}

/** Absolute difference amplified 4x, opaque, so a ghost of a few sRGB steps is visible. */
function diffImage(a, b) {
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i += 4) {
    out[i] = Math.min(255, Math.abs(a[i] - b[i]) * 4);
    out[i + 1] = Math.min(255, Math.abs(a[i + 1] - b[i + 1]) * 4);
    out[i + 2] = Math.min(255, Math.abs(a[i + 2] - b[i + 2]) * 4);
    out[i + 3] = 255;
  }
  return out;
}

function meanAbsDiff(a, b, width, [x0, y0, w, h]) {
  let sum = 0;
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) {
    const i = (y * width + x) * 4;
    sum += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
  }
  return sum / (w * h * 3);
}

/** Mean over the region of the per-pixel standard deviation across `frames` (rgb pooled). */
function temporalNoise(frames, width, [x0, y0, w, h]) {
  let sum = 0;
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) {
    for (let c = 0; c < 3; c++) {
      const i = (y * width + x) * 4 + c;
      let mean = 0;
      for (const f of frames) mean += f[i];
      mean /= frames.length;
      let variance = 0;
      for (const f of frames) variance += (f[i] - mean) ** 2;
      sum += Math.sqrt(variance / frames.length);
    }
  }
  return sum / (w * h * 3);
}

/** Wall-clock ms per frame over `frames` steady-state frames on one graph (first frame bakes and warms up). */
async function bench(gpu, target, state, frames) {
  const graph = await createGraph(gpu, target, 'atmosphere-bench');
  applyState(graph, state, target.size);
  bakeLuts(gpu, graph);
  frame(gpu, (current) => renderGraph(current, graph, target));
  await gpu.gpu.queue.onSubmittedWorkDone();
  const started = performance.now();
  for (let i = 0; i < frames; i++) {
    applyState(graph, { ...state, time: state.time + i / 60 }, target.size);
    frame(gpu, (current) => renderGraph(current, graph, target));
  }
  await gpu.gpu.queue.onSubmittedWorkDone();
  const perFrame = (performance.now() - started) / frames;
  const cloudless = { ...state, cloudCoverage: 0 };
  const startedCloudless = performance.now();
  for (let i = 0; i < frames; i++) {
    applyState(graph, { ...cloudless, time: state.time + i / 60 }, target.size);
    frame(gpu, (current) => renderGraph(current, graph, target));
  }
  await gpu.gpu.queue.onSubmittedWorkDone();
  const perFrameCloudless = (performance.now() - startedCloudless) / frames;
  return `${perFrame.toFixed(0)} ms/frame (${perFrameCloudless.toFixed(0)} ms without clouds, ${(perFrame - perFrameCloudless).toFixed(0)} ms clouds) at ${target.size.join('x')} over ${frames} frames`;
}

/** Mean sRGB of the top band (zenith-ish), middle band (horizon) and bottom band (ground) as a quick sanity readout. */
function describe(pixels, [width, height]) {
  const band = (y0, y1) => {
    const sum = [0, 0, 0];
    let count = 0;
    for (let y = y0; y < y1; y++) for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      sum[0] += pixels[i]; sum[1] += pixels[i + 1]; sum[2] += pixels[i + 2];
      count++;
    }
    return sum.map((v) => Math.round(v / count));
  };
  const top = band(0, Math.floor(height * 0.1));
  const middle = band(Math.floor(height * 0.45), Math.floor(height * 0.55));
  const bottom = band(Math.floor(height * 0.9), height);
  return `top=${top.join(',')} mid=${middle.join(',')} bottom=${bottom.join(',')}`;
}

function parseArgs(argv) {
  const parsed = { out: undefined, preset: undefined, size: undefined, debug: undefined, bench: 0, accumulate: 0, temporal: 0, region: undefined, jump: undefined, sweep: undefined, every: undefined, overrides: {} };
  const numeric = { sun: 'sunElevation', azimuth: 'sunAzimuth', altitude: 'altitudeKm', yaw: 'yaw', pitch: 'pitch', ev: 'exposureEv', haze: 'haze', coverage: 'cloudCoverage', detail: 'cloudDetail', type: 'cloudType', seed: 'cloudSeed', time: 'time' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--out') parsed.out = argv[++i];
    else if (arg === '--preset') parsed.preset = argv[++i];
    else if (arg === '--size') parsed.size = argv[++i].split('x').map(Number);
    else if (arg === '--debug') parsed.debug = argv[++i];
    else if (arg === '--bench') parsed.bench = Number(argv[++i]);
    else if (arg === '--accumulate') parsed.accumulate = Number(argv[++i]);
    else if (arg === '--temporal') parsed.temporal = Number(argv[++i]);
    else if (arg === '--region') parsed.region = argv[++i].split(',').map(Number);
    else if (arg === '--every') parsed.every = Number(argv[++i]);
    else if (arg === '--sweep') {
      const [key, range] = argv[++i].split('=');
      const [from, to] = range.split('..').map(Number);
      if (!numeric[key]) throw new Error(`Unknown override '${key}' in --sweep.`);
      parsed.sweep = { key: numeric[key], from, to };
    }
    else if (arg === '--jump') {
      const [frameText, assignment] = argv[++i].split(':');
      const [key, value] = assignment.split('=');
      if (!numeric[key]) throw new Error(`Unknown override '${key}' in --jump.`);
      parsed.jump = { frame: Number(frameText), overrides: { [numeric[key]]: Number(value) } };
    }
    else if (arg === '--tonemap') parsed.overrides.tonemap = argv[++i];
    else if (arg.startsWith('--') && numeric[arg.slice(2)]) parsed.overrides[numeric[arg.slice(2)]] = Number(argv[++i]);
    else throw new Error(`Unknown argument '${arg}'.`);
  }
  return parsed;
}

function wgslPlugin() {
  return {
    name: 'docs-wgsl',
    setup(build) {
      build.onLoad({ filter: /\.wgsl$/ }, async (file) => {
        const source = await import('node:fs/promises').then(({ readFile }) => readFile(file.path, 'utf8'));
        const result = await transformWgsl({ source, id: file.path });
        return { contents: result.code, loader: 'js', resolveDir: path.dirname(file.path) };
      });
    },
  };
}
