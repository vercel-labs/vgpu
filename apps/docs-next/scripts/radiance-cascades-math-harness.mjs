/**
 * Debug-extraction harness for the `radiance-cascades` example.
 *
 * Radiance cascades are multi-pass and every pass is mathematically non-trivial, so this
 * follows `docs/topics/shader-debugging.docs.md` from the start instead of iterating by
 * eye: each pure WGSL module is run in a tiny rgba8unorm target with one internal value
 * per channel, diffed against the CPU reference in `math.ts` at the rgba8unorm
 * quantization floor (2/255), and every intermediate render target is dumped as a PNG.
 *
 * Run it through `verify-radiance-cascades-math.sh`, which supplies the deterministic
 * container (this host has no adapter).
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { PNG } from 'pngjs';
import { init, effect, sampler, target } from 'vgpu/node';
import { transformWgsl } from '@vgpu/wgsl/loader-vite';

const docsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const exampleDir = path.join(docsDir, 'examples', 'radiance-cascades');
const outDir = process.env.OUT ? path.resolve(process.env.OUT) : path.join(docsDir, '.radiance-cascades-evidence');
const cacheDir = path.join(docsDir, '.rc-harness-cache');
const TOLERANCE = 2 / 255;
/** Scene size for the intermediate dumps: small enough to stay fast on a CPU renderer. */
const DUMP_SIZE = [96, 54];

await mkdir(outDir, { recursive: true });
await mkdir(cacheDir, { recursive: true });

const reference = await loadExampleModules();
const gpu = await init();
const evidence = { tolerance: TOLERANCE, chunks: {}, dumps: [], pass: true };

try {
  await checkDirections();
  await checkIntervals();
  await checkMerge();
  const scene = await checkJumpFloodAndTrace();
  await dumpPipeline(scene);
} finally {
  gpu.dispose();
}

evidence.pass = Object.values(evidence.chunks).every((chunk) => chunk.pass);
await writeFile(path.join(outDir, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
await rm(cacheDir, { recursive: true, force: true });
console.log(JSON.stringify({ pass: evidence.pass, chunks: summarise(evidence.chunks) }, null, 2));
if (!evidence.pass) process.exitCode = 1;

// ---------------------------------------------------------------------------------------

function summarise(chunks) {
  return Object.fromEntries(Object.entries(chunks).map(([name, chunk]) => [name, { maxError: chunk.maxError, pass: chunk.pass }]));
}

/** Bundles the example's TypeScript so the CPU reference is literally the shipped code. */
async function loadExampleModules() {
  const entry = path.join(cacheDir, 'reference-entry.ts');
  const bundle = path.join(cacheDir, 'reference.mjs');
  await writeFile(entry, [
    `export * as math from '${path.join(exampleDir, 'math.ts')}';`,
    `export * as validation from '${path.join(exampleDir, 'validation.ts')}';`,
    `export * as simulation from '${path.join(exampleDir, 'simulation.ts')}';`,
    '',
  ].join('\n'));
  await build({
    entryPoints: [entry],
    outfile: bundle,
    bundle: true,
    platform: 'node',
    format: 'esm',
    external: ['vgpu', 'vgpu/node'],
    plugins: [wgslPlugin()],
    logLevel: 'silent',
  });
  return import(pathToFileURL(bundle).href);
}

function wgslPlugin() {
  return {
    name: 'wgsl',
    setup(builder) {
      builder.onLoad({ filter: /\.wgsl$/u }, async (args) => {
        const source = await readFile(args.path, 'utf8');
        const result = await transformWgsl({ source, id: args.path });
        return { contents: result.code, loader: 'js', resolveDir: path.dirname(args.path) };
      });
    },
  };
}

/** Inlines a pure module into a debug entry shader: strip the import/export keywords. */
async function inlineModule(name) {
  const source = await readFile(path.join(exampleDir, name), 'utf8');
  return source.replace(/^import .*$/gmu, '').replace(/\bexport\s+/gu, '');
}

/**
 * An entry shader with its imports inlined.
 *
 * `effect(gpu, ...)` takes a single raw WGSL string — the import graph is a build-time feature
 * of the loader — so the harness resolves it the same way the guide describes: concatenate
 * the pure modules and strip the module keywords. The entry point itself is byte-for-byte
 * the file the browser ships.
 */
async function entryShader(name, dependencies) {
  const helpers = [];
  for (const dependency of dependencies) helpers.push(await inlineModule(dependency));
  return `${helpers.join('\n')}\n${await inlineModule(name)}`;
}

async function readSlots(shader, slots, targetOptions = {}) {
  const colorTarget = target(gpu, { size: [slots, 1], format: 'rgba8unorm', ...targetOptions });
  effect(gpu, shader).draw(colorTarget);
  const pixels = new Uint8Array(await colorTarget.read());
  return Array.from({ length: slots }, (_, slot) => [0, 1, 2, 3].map((channel) => pixels[slot * 4 + channel] / 255));
}

function record(name, referenceSlots, gpuSlots, extra = {}) {
  let maxError = 0;
  const flatReference = referenceSlots.flat();
  const flatGpu = gpuSlots.flat();
  for (let index = 0; index < flatReference.length; index++) {
    maxError = Math.max(maxError, Math.abs(flatReference[index] - flatGpu[index]));
  }
  evidence.chunks[name] = {
    ...extra,
    reference: referenceSlots,
    gpu: gpuSlots,
    maxError,
    tolerance: TOLERANCE,
    pass: maxError <= TOLERANCE,
  };
  console.log(`- ${name}: maxError=${maxError.toFixed(5)} ${maxError <= TOLERANCE ? 'pass' : 'FAIL'}`);
}

/** (a) Ray counts, directions and the direction-first atlas mapping, for R = 4, 16, 64. */
async function checkDirections() {
  const { math } = reference;
  const helpers = await inlineModule('rc-directions.wgsl');
  const shader = `${helpers}
@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let slot = i32(floor(uv.x * 8.0));
  // 0..2: first and last direction of R = 4, 16, 64, mapped from [-1,1] to [0,1].
  if (slot == 0) { return vec4f(rc_direction(0.0, 4.0) * 0.5 + 0.5, rc_direction(3.0, 4.0) * 0.5 + 0.5); }
  if (slot == 1) { return vec4f(rc_direction(0.0, 16.0) * 0.5 + 0.5, rc_direction(15.0, 16.0) * 0.5 + 0.5); }
  if (slot == 2) { return vec4f(rc_direction(0.0, 64.0) * 0.5 + 0.5, rc_direction(31.0, 64.0) * 0.5 + 0.5); }
  // 3: atlas texel of probe (3,2) direction 7 at cascade 1 (block 4), normalised by 64.
  if (slot == 3) { return vec4f(rc_atlas_texel(vec2f(3.0, 2.0), 7.0, 4.0) / 64.0, 0.0, 1.0); }
  // 4: the same texel decoded back into probe + direction.
  if (slot == 4) { let d = rc_atlas_decode(vec2f(15.0, 9.0), 4.0); return vec4f(d.x / 16.0, d.y / 16.0, d.z / 64.0, 1.0); }
  // 5: cascade 2 (block 8, 64 rays), probe (5,4) direction 37.
  if (slot == 5) { return vec4f(rc_atlas_texel(vec2f(5.0, 4.0), 37.0, 8.0) / 64.0, 0.0, 1.0); }
  // 6: probe origin at spacing 4, normalised by 64.
  if (slot == 6) { return vec4f(rc_probe_origin(vec2f(3.0, 2.0), 4.0) / 64.0, 0.0, 1.0); }
  // 7: block size, spacing and ray count of the levels, normalised by 64.
  return vec4f(rc_block_size(0.0) / 64.0, rc_block_size(2.0) / 64.0, rc_probe_spacing(3.0) / 64.0, rc_ray_count(1.0) / 64.0);
}`;

  const dir = (index, rays) => math.rayDirection(index, rays).map((value) => value * 0.5 + 0.5);
  const decoded = math.atlasDecode([15, 9], 4);
  const cpu = [
    [...dir(0, 4), ...dir(3, 4)],
    [...dir(0, 16), ...dir(15, 16)],
    [...dir(0, 64), ...dir(31, 64)],
    [...math.atlasTexel([3, 2], 7, 4).map((value) => value / 64), 0, 1],
    [decoded[0] / 16, decoded[1] / 16, decoded[2] / 64, 1],
    [...math.atlasTexel([5, 4], 37, 8).map((value) => value / 64), 0, 1],
    [...math.probeOrigin([3, 2], 4).map((value) => value / 64), 0, 1],
    [math.blockSize(0) / 64, math.blockSize(2) / 64, math.probeSpacing(3) / 64, math.rayCount(1) / 64],
  ];
  record('rc-directions', cpu, await readSlots(shader, 8), { encoding: 'direction*0.5+0.5; texels and counts /64' });
}

/** (b) Geometric intervals for cascades 0..5, the 4x ratio, the 2% overlap and unit weights. */
async function checkIntervals() {
  const { math } = reference;
  const helpers = `${await inlineModule('rc-intervals.wgsl')}\n${await inlineModule('rc-merge.wgsl')}`;
  const scale = 4096;
  const shader = `${helpers}
const I0: f32 = ${math.RC_INTERVAL0.toFixed(1)};
const OVERLAP: f32 = ${math.RC_OVERLAP};
@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let slot = floor(uv.x * 8.0);
  // 0..5: start, length and overlapped end of each cascade, normalised by 4096 px.
  if (slot < 6.0) {
    return vec4f(
      rc_interval_start(slot, I0) / ${scale}.0,
      rc_interval_length(slot, I0) / ${scale}.0,
      rc_interval_end(slot, I0, OVERLAP) / ${scale}.0,
      1.0,
    );
  }
  // 6: cascade counts for a 1280x720 and a 320x180 canvas, and the distance six levels cover.
  if (slot < 7.0) {
    return vec4f(
      rc_cascade_count(1468.6, I0) / 8.0,
      rc_cascade_count(367.2, I0) / 8.0,
      rc_covered_distance(6.0, I0) / ${scale}.0,
      1.0,
    );
  }
  // 7: invariants — the ratio between levels is 4, the overlap is exactly 2% of the
  // previous length, four branch weights sum to 1, and so do the bilinear weights.
  let weights = rc_bilinear_weights(vec2f(0.37, 0.62));
  return vec4f(
    rc_interval_length(3.0, I0) / rc_interval_length(2.0, I0) / 8.0,
    (rc_interval_end(2.0, I0, OVERLAP) - rc_interval_start(3.0, I0)) / (rc_interval_length(2.0, I0) * OVERLAP),
    4.0 * RC_BRANCH_WEIGHT,
    weights.x + weights.y + weights.z + weights.w,
  );
}`;

  const cpu = [];
  for (let cascade = 0; cascade < 6; cascade++) {
    cpu.push([
      math.intervalStart(cascade) / scale,
      math.intervalLength(cascade) / scale,
      math.intervalEnd(cascade) / scale,
      1,
    ]);
  }
  cpu.push([math.cascadeCount(1468.6) / 8, math.cascadeCount(367.2) / 8, math.coveredDistance(6) / scale, 1]);
  const weights = math.bilinearWeights(0.37, 0.62);
  cpu.push([
    math.intervalLength(3) / math.intervalLength(2) / 8,
    (math.intervalEnd(2) - math.intervalStart(3)) / (math.intervalLength(2) * math.RC_OVERLAP),
    4 * math.RC_BRANCH_WEIGHT,
    weights.reduce((total, weight) => total + weight, 0),
  ]);
  record('rc-intervals', cpu, await readSlots(shader, 8), { encoding: `distances /${scale}; counts /8; invariants raw` });
}

/** (c) The visibility merge at alpha 0, 1 and in between, plus the bilinear weights. */
async function checkMerge() {
  const { math } = reference;
  const helpers = await inlineModule('rc-merge.wgsl');
  const shader = `${helpers}
@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let slot = i32(floor(uv.x * 8.0));
  let far = vec4f(0.5, 0.25, 0.75, 1.0);
  // 0: the near interval saw nothing (alpha 1) — the far radiance passes through intact.
  if (slot == 0) { return rc_merge(vec4f(0.0, 0.0, 0.0, 1.0), far); }
  // 1: the near interval hit an occluder (alpha 0) — nothing behind it contributes.
  if (slot == 1) { return rc_merge(vec4f(0.4, 0.5, 0.6, 0.0), far); }
  // 2: partial visibility.
  if (slot == 2) { return rc_merge(vec4f(0.2, 0.1, 0.05, 0.5), vec4f(0.5, 0.25, 0.75, 0.5)); }
  if (slot == 3) { return rc_bilinear_weights(vec2f(0.25, 0.5)); }
  if (slot == 4) { return rc_bilinear_weights(vec2f(0.0, 0.0)); }
  if (slot == 5) { return rc_bilinear_weights(vec2f(1.0, 1.0)); }
  // 6: a probe walking off the grid is clamped in probe space, not texel space.
  if (slot == 6) { return vec4f(rc_clamp_probe(vec2f(-1.0, 9.0), vec2f(8.0, 8.0)) / 8.0, 0.0, 1.0); }
  // 7: half-texel UV clamp against light leaking across the border.
  return vec4f(rc_clamp_uv(vec2f(-0.2, 1.4), vec2f(8.0, 8.0)), 0.0, 1.0);
}`;

  const far = [0.5, 0.25, 0.75, 1];
  const cpu = [
    math.mergeRadiance([0, 0, 0, 1], far),
    math.mergeRadiance([0.4, 0.5, 0.6, 0], far),
    math.mergeRadiance([0.2, 0.1, 0.05, 0.5], [0.5, 0.25, 0.75, 0.5]),
    math.bilinearWeights(0.25, 0.5),
    math.bilinearWeights(0, 0),
    math.bilinearWeights(1, 1),
    [...math.clampProbe([-1, 9], [8, 8]).map((value) => value / 8), 0, 1],
    [...math.clampUv([-0.2 * 8, 1.4 * 8], [8, 8]), 0, 1],
  ];
  record('rc-merge', cpu, await readSlots(shader, 8), { encoding: 'raw [0,1] values; probes /8' });
}

/**
 * (d) and (e): the real jump-flood and sphere-tracing entry shaders on an 8x8 scene.
 *
 * The seeds live in rgba32float — f16 cannot hold a pixel coordinate exactly — and the
 * distance field is written into rgba8unorm with `encode_scale`, so the CPU reference reads
 * back exactly the bytes the tracer samples and the comparison isolates the algorithm from
 * the storage format.
 */
async function checkJumpFloodAndTrace() {
  const { math } = reference;
  const size = [8, 8];
  const far = 16;
  const encodeScale = 1 / far;

  // Two emitter texels — alpha is the occluder mask the flood seeds from — rendered twice
  // over different radiance fields:
  //
  //  * flat: one constant colour, so whatever sub-pixel point the ray stops at, the
  //    radiance it returns is exactly that colour. This is the value compared at 2/255.
  //  * ramp: a linear function of position, which bilinear filtering reproduces exactly, so
  //    the radiance *is* the hit position and the second chunk can measure where the march
  //    landed in pixels.
  const MASK = '(p.x == 2.5 && p.y == 3.5) || (p.x == 6.5 && p.y == 1.5)';
  const emitter = target(gpu, { size, format: 'rgba8unorm', label: 'rc-harness-emitter' });
  effect(gpu, `
    @fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
      let p = floor(uv * 8.0) + 0.5;
      return vec4f(0.9, 0.5, 0.2, select(0.0, 1.0, ${MASK}));
    }
  `).draw(emitter);
  const emitterRamp = target(gpu, { size, format: 'rgba8unorm', label: 'rc-harness-emitter-ramp' });
  effect(gpu, `
    @fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
      let p = floor(uv * 8.0) + 0.5;
      return vec4f(p.x / 8.0, p.y / 8.0, 0.5, select(0.0, 1.0, ${MASK}));
    }
  `).draw(emitterRamp);

  const jfaInit = effect(gpu, await entryShader('jfa-init.wgsl', ['jfa-step.wgsl']), { label: 'rc-harness-jfa-init' });
  const seeds = [
    target(gpu, { size, format: 'rgba32float', label: 'rc-harness-seed-a' }),
    target(gpu, { size, format: 'rgba32float', label: 'rc-harness-seed-b' }),
  ];
  jfaInit.set({ jfa: { size, threshold: 0.5, _pad: 0 }, emitter });
  jfaInit.draw(seeds[0]);

  const jumps = math.jfaJumps(8);
  let read = seeds[0];
  let write = seeds[1];
  for (const jump of jumps) {
    const step = effect(gpu, await entryShader('jfa-pass.wgsl', ['jfa-step.wgsl']), { label: `rc-harness-jfa-${jump}` });
    step.set({ jfa: { size, jump, _pad: 0 }, seeds: read });
    step.draw(write);
    const previous = read;
    read = write;
    write = previous;
  }

  const sdf = target(gpu, { size, format: 'rgba8unorm', label: 'rc-harness-sdf' });
  const finalize = effect(gpu, await entryShader('sdf-finalize.wgsl', ['jfa-step.wgsl']), { label: 'rc-harness-sdf-finalize' });
  finalize.set({ sdf: { size, far, encode_scale: encodeScale }, seeds: read });
  finalize.draw(sdf);

  const sdfBytes = new Uint8Array(await sdf.read());
  const emitterBytes = new Uint8Array(await emitter.read());
  const rampBytes = new Uint8Array(await emitterRamp.read());
  const view = (bytes) => ({ width: 8, height: 8, channels: 4, data: [...bytes].map((byte) => byte / 255) });
  const sdfView = view(sdfBytes);
  const emitterView = view(emitterBytes);
  const rampView = view(rampBytes);

  // (d) Every texel of the flooded field against a brute-force nearest-emitter search.
  const mask = { width: 8, height: 8, channels: 4, data: emitterView.data };
  const cpuDistances = [];
  const gpuDistances = [];
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      cpuDistances.push(math.bruteForceDistance(mask, [x + 0.5, y + 0.5], far) * encodeScale);
      gpuDistances.push(sdfView.data[(y * 8 + x) * 4]);
    }
  }
  record('jfa-step', [cpuDistances], [gpuDistances], {
    jumps,
    encoding: `distance * ${encodeScale} (rgba8unorm), 8x8 texels, brute-force nearest as the reference`,
  });
  await writePng(path.join(outDir, 'harness-sdf-8x8.png'), sdfBytes, 8, 8);
  await writePng(path.join(outDir, 'harness-emitter-8x8.png'), emitterBytes, 8, 8);

  // (e) The sphere tracer: hits, escapes, an interval that stops short, and a ray that
  // starts inside an emitter. The oracle is the fixed-step march, used here and nowhere else.
  const cases = [
    { origin: [0.5, 3.5], direction: [1, 0], start: 0, end: 8, note: 'straight hit' },
    { origin: [0.5, 3.5], direction: [1, 0], start: 0, end: 1, note: 'interval stops short' },
    { origin: [0.5, 3.5], direction: [-1, 0], start: 0, end: 8, note: 'escapes off-screen' },
    { origin: [7.5, 7.5], direction: normalise([-5, -4]), start: 0, end: 12, note: 'diagonal hit' },
    { origin: [0.5, 0.5], direction: normalise([6, 1]), start: 0, end: 12, note: 'hits the blue emitter' },
    { origin: [4.5, 4.5], direction: [0, -1], start: 0, end: 6, note: 'misses between emitters' },
    { origin: [2.5, 3.5], direction: [1, 0], start: 0, end: 4, note: 'starts inside an emitter' },
    { origin: [0.5, 3.5], direction: [1, 0], start: 4, end: 8, note: 'interval starts past the emitter' },
  ];
  const traceHelpers = await inlineModule('sdf-sample.wgsl');
  const caseTable = cases
    .map((entry, index) => `  if (slot == ${index}) { return trace_case(vec2f(${entry.origin[0]}, ${entry.origin[1]}), vec2f(${entry.direction[0]}, ${entry.direction[1]}), ${entry.start.toFixed(1)}, ${entry.end.toFixed(1)}); }`)
    .join('\n');
  const oracleTable = cases
    .map((entry, index) => `  if (slot == ${index}) { return oracle_case(vec2f(${entry.origin[0]}, ${entry.origin[1]}), vec2f(${entry.direction[0]}, ${entry.direction[1]}), ${entry.start.toFixed(1)}, ${entry.end.toFixed(1)}); }`)
    .join('\n');
  const bindings = `
@group(0) @binding(0) var sdf_tex: texture_2d<f32>;
@group(0) @binding(1) var sdf_samp: sampler;
@group(0) @binding(2) var emitter_tex: texture_2d<f32>;
@group(0) @binding(3) var emitter_samp: sampler;
const SIZE: vec2f = vec2f(8.0, 8.0);
const SCALE: f32 = ${far}.0;
fn trace_case(origin: vec2f, direction: vec2f, start: f32, end: f32) -> vec4f {
  return sphere_trace(sdf_tex, sdf_samp, emitter_tex, emitter_samp, SIZE, origin, direction, start, end, SCALE);
}
fn oracle_case(origin: vec2f, direction: vec2f, start: f32, end: f32) -> vec4f {
  return fixed_step_trace(sdf_tex, sdf_samp, emitter_tex, emitter_samp, SIZE, origin, direction, start, end, SCALE, 512);
}`;
  const samplerState = sampler(gpu, { minFilter: 'linear', magFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });

  const runTrace = async (table, emitterTexture, label) => {
    const colorTarget = target(gpu, { size: [cases.length, 1], format: 'rgba8unorm', label });
    const shader1 = effect(gpu, `${traceHelpers}${bindings}
@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let slot = i32(floor(uv.x * ${cases.length}.0));
${table}
  return vec4f(0.0);
}`, { label });
    shader1.set({ sdf_tex: sdf, sdf_samp: samplerState, emitter_tex: emitterTexture, emitter_samp: samplerState });
    shader1.draw(colorTarget);
    const pixels = new Uint8Array(await colorTarget.read());
    return cases.map((_, index) => [0, 1, 2, 3].map((channel) => pixels[index * 4 + channel] / 255));
  };

  const gpuTrace = await runTrace(caseTable, emitter, 'rc-harness-trace');
  const gpuOracle = await runTrace(oracleTable, emitter, 'rc-harness-oracle');
  const gpuRamp = await runTrace(caseTable, emitterRamp, 'rc-harness-trace-ramp');
  const gpuOracleRamp = await runTrace(oracleTable, emitterRamp, 'rc-harness-oracle-ramp');

  const cpuTrace = cases.map((entry) => {
    const result = math.sphereTrace(sdfView, emitterView, [8, 8], entry.origin, entry.direction, entry.start, entry.end, far);
    return [...result.radiance, result.visibility];
  });
  record('sdf-sample', cpuTrace, gpuTrace, {
    cases: cases.map((entry) => entry.note),
    encoding: 'rgb = linear radiance of the emitter hit (flat field), a = visibility (1 escaped, 0 hit)',
  });

  // Where the march landed, in pixels, read out of the linear ramp.
  //
  // This is not held to 2/255: that tolerance is the quantization floor of a *stored*
  // value, and a hit position is not stored — it is the end of a sixteen-step march
  // through a hardware-filtered field, where f32 arithmetic and the filter's sub-texel
  // precision move the landing point by a fraction of a texel. The guarantee the tracer
  // actually makes is its own epsilon: both sides stop within half a texel of the surface.
  const cpuRamp = cases.map((entry) => {
    const result = math.sphereTrace(sdfView, rampView, [8, 8], entry.origin, entry.direction, entry.start, entry.end, far);
    return [...result.radiance, result.visibility];
  });
  let maxPositionError = 0;
  const positions = cases.map((entry, index) => {
    const cpu = [cpuRamp[index][0] * 8, cpuRamp[index][1] * 8];
    const shader = [gpuRamp[index][0] * 8, gpuRamp[index][1] * 8];
    const error = cpuRamp[index][3] > 0.5 ? 0 : Math.hypot(cpu[0] - shader[0], cpu[1] - shader[1]);
    maxPositionError = Math.max(maxPositionError, error);
    return { case: entry.note, hit: cpuRamp[index][3] < 0.5, cpu, shader, errorPixels: error };
  });
  const epsilonBudget = 0.5;
  const visibilityAgrees = cases.every((_, index) => Math.abs(cpuRamp[index][3] - gpuRamp[index][3]) <= TOLERANCE);
  evidence.chunks['sdf-sample-hit-position'] = {
    encoding: 'emitter radiance is a linear ramp of position, so rgb decodes the hit point in pixels',
    positions,
    visibilityAgrees,
    maxErrorPixels: maxPositionError,
    budgetPixels: epsilonBudget,
    maxError: 0,
    tolerance: TOLERANCE,
    pass: visibilityAgrees && maxPositionError <= epsilonBudget,
  };
  console.log(`- sdf-sample-hit-position: visibility ${visibilityAgrees ? 'identical' : 'DIVERGED'}, max landing offset ${maxPositionError.toFixed(3)} px (budget ${epsilonBudget})`);
  // The fixed-step march is the debug oracle only; production always sphere traces.
  //
  // The two cannot agree to 2/255 by construction: sphere tracing stops at the first step
  // whose distance is under the epsilon and may overshoot by up to one minimum step, while
  // a 512-step march stops right at the epsilon crossing. What must hold is that they
  // agree on *whether* the ray hit, and that the hit positions — read out of the ramp —
  // are within that one step of each other.
  const visibilityMatches = gpuTrace.every((slot, index) => Math.abs(slot[3] - gpuOracle[index][3]) <= TOLERANCE);
  let maxHitOffset = 0;
  gpuRamp.forEach((slot, index) => {
    if (slot[3] > 0.5) return;
    const dx = (slot[0] - gpuOracleRamp[index][0]) * 8;
    const dy = (slot[1] - gpuOracleRamp[index][1]) * 8;
    maxHitOffset = Math.max(maxHitOffset, Math.hypot(dx, dy));
  });
  const oracleBudget = 1.0;
  evidence.chunks['sdf-sample-vs-fixed-step-oracle'] = {
    oracleSteps: 512,
    note: 'the fixed-step march exists only here; production always sphere traces',
    sphereTrace: gpuTrace,
    fixedStep: gpuOracle,
    sphereTraceHitPositions: gpuRamp.map((slot) => [slot[0] * 8, slot[1] * 8]),
    fixedStepHitPositions: gpuOracleRamp.map((slot) => [slot[0] * 8, slot[1] * 8]),
    visibilityMatches,
    maxHitOffsetPixels: maxHitOffset,
    budgetPixels: oracleBudget,
    maxError: 0,
    tolerance: TOLERANCE,
    pass: visibilityMatches && maxHitOffset <= oracleBudget,
  };
  console.log(`- sdf-sample-vs-fixed-step-oracle: visibility ${visibilityMatches ? 'identical' : 'DIVERGED'}, max hit offset ${maxHitOffset.toFixed(3)} px (budget ${oracleBudget})`);

  return { sampler: samplerState };
}

/** Dumps every intermediate render target of a real 96x54 frame, twice, and hashes both. */
async function dumpPipeline({ sampler: samplerState }) {
  const { validation } = reference;
  const hashes = new Map();

  for (const run of [1, 2]) {
    const seen = [];
    const scene = await validation.renderStaged(gpu, DUMP_SIZE, async (name, colorTarget) => {
      const file = `${name}.png`;
      const bytes = await encodeStage(name, colorTarget, samplerState);
      if (run === 1) await writePng(path.join(outDir, file), bytes.pixels, bytes.width, bytes.height);
      seen.push(file);
      const digest = createHash('sha256').update(bytes.pixels).digest('hex');
      if (run === 1) hashes.set(file, digest);
      else if (hashes.get(file) !== digest) throw new Error(`Non-deterministic stage ${file}: ${hashes.get(file)} != ${digest}`);
    }, { scriptedStroke: true });

    // The composed image, through the same present pass the browser uses.
    const finalTarget = target(gpu, { size: DUMP_SIZE, format: 'rgba8unorm', label: 'rc-harness-final' });
    reference.simulation.presentScene(scene, finalTarget, 'final');
    await gpu.gpu.queue.onSubmittedWorkDone();
    const finalPixels = new Uint8Array(await finalTarget.read());
    if (run === 1) {
      await writePng(path.join(outDir, 'final.png'), finalPixels, DUMP_SIZE[0], DUMP_SIZE[1]);
      evidence.dumps = [...seen, 'final.png'];
      hashes.set('final.png', createHash('sha256').update(finalPixels).digest('hex'));
    } else if (hashes.get('final.png') !== createHash('sha256').update(finalPixels).digest('hex')) {
      throw new Error('Non-deterministic final image.');
    }
    reference.simulation.destroyScene(scene);
  }

  evidence.chunks.determinism = {
    runs: 2,
    files: evidence.dumps.length,
    sha256: Object.fromEntries(hashes),
    maxError: 0,
    tolerance: TOLERANCE,
    pass: true,
  };
  console.log(`- determinism: ${evidence.dumps.length} dumps identical across two runs`);
}

/** Encodes one intermediate into displayable bytes; HDR and seed targets are not readable. */
async function encodeStage(name, colorTarget, samplerState) {
  const [width, height] = colorTarget.size;
  const readable = target(gpu, { size: [width, height], format: 'rgba8unorm', label: `rc-dump-${name}` });
  let shader;
  if (name.includes('jfa')) {
    // Seed field: each texel takes the colour of the emitter it points at — the classic
    // Voronoi picture of a jump flood, and immediately wrong-looking when a round misfires.
    shader = `
      @group(0) @binding(0) var src: texture_2d<f32>;
      @fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
        let size = vec2f(${width}.0, ${height}.0);
        let seed = textureLoad(src, vec2i(uv * size), 0);
        if (seed.w < 0.5) { return vec4f(0.0, 0.0, 0.0, 1.0); }
        return vec4f(seed.xy / size, 0.25, 1.0);
      }`;
  } else if (name.includes('sdf')) {
    shader = `
      ${(await inlineModule('scene-grid.wgsl'))}
      @group(0) @binding(0) var src: texture_2d<f32>;
      @fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
        let d = textureLoad(src, vec2i(uv * vec2f(${width}.0, ${height}.0)), 0).r;
        return vec4f(linear_to_srgb(distance_ramp(d, 24.0)), 1.0);
      }`;
  } else {
    shader = `
      ${(await inlineModule('scene-grid.wgsl'))}
      @group(0) @binding(0) var src: texture_2d<f32>;
      @fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
        let c = textureLoad(src, vec2i(uv * vec2f(${width}.0, ${height}.0)), 0);
        return vec4f(linear_to_srgb(tonemap_aces(c.rgb)), 1.0);
      }`;
  }
  const shader1 = effect(gpu, shader, { label: `rc-dump-${name}` });
  shader1.set({ src: colorTarget });
  shader1.draw(readable);
  await gpu.gpu.queue.onSubmittedWorkDone();
  return { pixels: new Uint8Array(await readable.read()), width, height };
}

function normalise([x, y]) {
  const length = Math.hypot(x, y);
  return [x / length, y / length];
}

async function writePng(file, pixels, width, height) {
  const png = new PNG({ width, height });
  png.data.set(pixels);
  await writeFile(file, PNG.sync.write(png));
}
