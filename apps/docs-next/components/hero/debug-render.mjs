#!/usr/bin/env node
// Headless debug harness for the hero black hole.
//
// Runs the real pipeline (bake -> shade) on the Node/Dawn adapter, with no
// browser, and writes PNGs for the final frame plus every G-buffer debug view.
// Use it to iterate on disk.wgsl / stars.wgsl and to prove what the bake
// actually produced.
//
// Two passes, exactly like the page: shade tone maps in place and writes the
// display-referred image straight to an rgba8unorm target. There is no HDR
// scene target and no composite pass.
//
//   node apps/docs/components/hero/debug-render.mjs
//   node apps/docs/components/hero/debug-render.mjs --size 960x540 --time 4
//   node apps/docs/components/hero/debug-render.mjs --views final,flags
//   node apps/docs/components/hero/debug-render.mjs --disk.stretch 3 --disk.detail 1.6
//   node apps/docs/components/hero/debug-render.mjs --set '{"disk":{"brightness":2}}'
//   node apps/docs/components/hero/debug-render.mjs --views final --diskLayers 1 --out /tmp/before
//
// Flags:
//   --out <dir>          output directory (default /home/user/reports/hero-debug)
//   --size <WxH>         render size in pixels (default 1280x720)
//   --time <seconds>     animation clock handed to the shaders (default 2.5)
//   --views <list>       comma list of: final,normals,diskuv,flags,raydir,density,
//                        skylod,hit2,aa,aageom,all
//   --aa <0|1>           1 = consume the refine pass's ring coverage/span (default),
//                        0 = ignore it, i.e. exactly the pre-AA image. The A/B.
//   --<key> <value>      any geometry setting: cameraY, distance, diskRadius, fov, centerY
//   --diskLayers <1|2>   1 = front disk hit only, 2 = also the hidden second hit (A/B)
//   --yaw <radians>      SCENE yaw applied by the frame pass (default 0). This is the
//                        instantaneous rotation, not the mouse amplitude: the harness
//                        has no pointer and no smoothing, so `mouseYaw` is ignored.
//   --bakeYaw <radians>  CAMERA yaw baked into the G-buffer (default 0). Ground truth
//                        for the rotation: `--yaw t` must match `--bakeYaw -t`.
//   --disk.<key> <v>     any DiskLook field (brightness, speed, stretch, detail, ...)
//   --stars.<key> <v>    any StarLook field (brightness, density, contrast, warmth, twinkle)
//   --noiseSize <n>      edge of the tiled 3D noise lattice (default 64; try 128 to
//                        A/B whether the tiling repeats visibly)
//   --ssaa <n>           render n x size and box-downsample IN LINEAR LIGHT (decode
//                        2.2, average, re-encode) to `--size`. n = 1 is the shipped
//                        path, bit-for-bit. This is the AA REFERENCE: n = 3 is what
//                        the photon-ring antialiasing is judged against, and n = 2
//                        already agrees closely with it (~9 samples/px is converged).
//                        Note the bake runs at the supersampled resolution too, so
//                        this is true SSAA, not a post filter.
//   --crop <x,y,w,h[,s]> after downsampling, also write `<view>-crop.png`: the given
//                        rect of the FINAL image, nearest-neighbour zoomed by s
//                        (default 10). Coordinates are in `--size` pixels, so the
//                        same rect lands on the same features at any `--ssaa`.
//   --set <json>         deep-merged JSON settings patch (wins over flags)
//   --json               print the resolved settings and per-image stats as JSON
//   --allow-black        do not fail on an all-black image (see "Exit codes")
//
// Exit codes — this harness is meant to be trusted by CI and by agents:
//   0  every requested view rendered and the GPU reported no error
//   1  something is wrong; the PNGs are NOT trustworthy. Three ways to get here:
//      * the GPU reported an error (WGSL that does not compile, a pipeline that
//        does not validate, a bad binding). PRIMARY detection: every error the
//        device reports is captured (`gpu.onError` plus the device's
//        `uncapturederror` channel) and printed verbatim, including Dawn's WGSL
//        line/caret diagnostic. Without this a broken shader used to write a
//        black PNG, report `mean=0 std=0` and still exit 0 — a false pass.
//      * the harness threw (bad flag, missing view, resolver failure).
//      * SECONDARY, belt-and-braces: a rendered view is all black (every RGB
//        byte 0) and no GPU error explained it. A black frame is the classic
//        symptom of a shader that silently failed, but it CAN be legitimate —
//        `--disk.brightness 0 --stars.brightness 0` is genuinely black — so
//        pass `--allow-black` for those runs.
//
// The WGSL import graph (shade.wgsl -> gbuffer/disk/stars) is resolved with
// `resolveShader`, the same resolver the webpack/turbopack loader uses in the app.

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PNG } from 'pngjs';
import { resolveShader } from '@vgpu/wgsl/runtime';
// vgpu 0.2.0 is free functions over a minimal `Gpu`: `target`/`effect`/`frame`
// take the gpu as their first argument instead of hanging off it.
import * as vgpu from 'vgpu/node';
import { init } from 'vgpu/node';

import { createNoiseVolume, NOISE_VOLUME_SIZE, noiseVolumeSampler } from './noise-volume.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Keep in sync with `defaultHeroSettings()` in renderer.ts. */
const DEFAULT_SETTINGS = {
  cameraY: 0.085,
  distance: 13.5,
  diskRadius: 6.9,
  fov: 2.67,
  centerY: 0,
  debugView: 0,
  diskLayers: 2,
  // Photon-ring antialiasing A/B: `--aa 0` reproduces the pre-AA image exactly
  // (the refine pass still runs; the frame pass just ignores its target).
  aa: 1,
  // Mouse amplitude in the browser. The harness has no pointer: use --yaw to set
  // an instantaneous scene rotation instead.
  mouseYaw: 0.15,
  disk: {
    brightness: 0.098,
    speed: 0.75,
    stretch: 5.75,
    detail: 3.44,
    turbulence: 4.46,
    density: 1.38,
    doppler: 1.21,
    spare0: 0.43,
    spare1: -0.25,
    spare2: -0.67,
    spare3: 0.69,
  },
  stars: {
    // `brightness: 1` is the calibrated look (stars.wgsl owns the absolute
    // scale). Keep in sync with defaultHeroSettings() in renderer.ts.
    brightness: 1,
    density: 1,
    contrast: 13,
    warmth: 0.5,
    twinkle: 0,
  },
};

/** debugView value -> file name. `final` is debugView 0. */
const VIEWS = {
  final: 0,
  normals: 1,
  diskuv: 2,
  flags: 3,
  raydir: 4,
  density: 5,
  skylod: 6,
  hit2: 7,
  aa: 8,
  aageom: 9,
};

/** hit1, hit2, sky, view. Must match GBUFFER_FORMATS in renderer.ts. */
const GBUFFER_FORMATS = ['rg32float', 'rg32float', 'rgba16float', 'rgba16float'];
/**
 * Photon-ring AA attachments: (coverage, span) and the synthesized crossing
 * (plane xz + encoded direction). Must match AA_FORMATS in renderer.ts.
 */
const AA_FORMATS = ['rg8unorm', 'rgba16float'];

function parseArgs(argv) {
  const options = { views: ['all'], size: [1280, 720], time: 2.5, out: '/home/user/reports/hero-debug', json: false, allowBlack: false, yaw: 0, bakeYaw: 0, noiseSize: NOISE_VOLUME_SIZE, ssaa: 1, crop: undefined };
  const patch = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const eq = token.indexOf('=');
    const key = (eq === -1 ? token.slice(2) : token.slice(2, eq)).trim();
    const readValue = () => (eq === -1 ? argv[++i] : token.slice(eq + 1));
    if (key === 'json') { options.json = true; continue; }
    // Boolean, so it must be matched before the generic `--<key> <value>` fallthrough.
    if (key === 'allow-black' || key === 'allowBlack') { options.allowBlack = true; continue; }
    const value = readValue();
    if (value === undefined) throw new Error(`missing value for --${key}`);
    if (key === 'out') { options.out = value; continue; }
    if (key === 'size') {
      const [w, h] = value.split(/[x,]/).map(Number);
      options.size = [Math.max(1, w | 0), Math.max(1, h | 0)];
      continue;
    }
    if (key === 'time') { options.time = Number(value); continue; }
    if (key === 'noiseSize') { options.noiseSize = Math.max(2, Number(value) | 0); continue; }
    if (key === 'ssaa') { options.ssaa = Math.max(1, Number(value) | 0); continue; }
    if (key === 'crop') {
      const [x, y, w, h, scale] = value.split(/[x,]/).map(Number);
      options.crop = { x: x | 0, y: y | 0, w: Math.max(1, w | 0), h: Math.max(1, h | 0), scale: Math.max(1, (scale || 10) | 0) };
      continue;
    }
    // Scene yaw vs camera yaw: `--yaw t` rotates the scene in the frame pass and
    // must produce the same image as `--bakeYaw -t`, which rotates the camera and
    // re-bakes. That equivalence is the whole justification for the feature.
    if (key === 'yaw') { options.yaw = Number(value); continue; }
    if (key === 'bakeYaw') { options.bakeYaw = Number(value); continue; }
    if (key === 'views') { options.views = value.split(',').map((v) => v.trim()).filter(Boolean); continue; }
    if (key === 'set') { deepMerge(patch, JSON.parse(value)); continue; }
    setPath(patch, key.split('.'), Number(value));
  }
  return { options, patch };
}

function setPath(target, path, value) {
  let cursor = target;
  for (let i = 0; i < path.length - 1; i++) {
    cursor[path[i]] ??= {};
    cursor = cursor[path[i]];
  }
  cursor[path[path.length - 1]] = value;
}

function deepMerge(base, patch) {
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      base[key] = deepMerge({ ...(base[key] ?? {}) }, value);
    } else {
      base[key] = value;
    }
  }
  return base;
}

async function loadShader(name) {
  const resolved = await resolveShader({ entry: resolve(HERE, name), rootDir: HERE, validate: false });
  return resolved.wgsl;
}

function writePng(path, width, height, rgba) {
  const png = new PNG({ width, height });
  rgba.forEach((byte, index) => { png.data[index] = byte; });
  return new Promise((done, fail) => {
    const chunks = [];
    png.pack()
      .on('data', (chunk) => chunks.push(chunk))
      .on('error', fail)
      .on('end', () => { writeFile(path, Buffer.concat(chunks)).then(done, fail); });
  });
}

/**
 * Box-downsamples an `n`x supersampled RGBA image IN LINEAR LIGHT.
 *
 * The gamma round trip is the whole point: `shade.wgsl` writes display-referred
 * sRGB-ish bytes (`pow(color, 1/2.2)`), and averaging those directly is
 * averaging the wrong quantity — it under-weights the bright sub-samples, which
 * is exactly the light the reference is supposed to prove is missing. Decode
 * 2.2, average, re-encode.
 */
function downsampleLinear(rgba, width, height, n) {
  if (n <= 1) return rgba;
  const outWidth = Math.floor(width / n);
  const outHeight = Math.floor(height / n);
  const out = Buffer.alloc(outWidth * outHeight * 4);
  const inverse = 1 / (n * n);
  for (let y = 0; y < outHeight; y++) {
    for (let x = 0; x < outWidth; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < n; sy++) {
        for (let sx = 0; sx < n; sx++) {
          const i = ((y * n + sy) * width + (x * n + sx)) * 4;
          r += (rgba[i] / 255) ** 2.2;
          g += (rgba[i + 1] / 255) ** 2.2;
          b += (rgba[i + 2] / 255) ** 2.2;
          a += rgba[i + 3];
        }
      }
      const o = (y * outWidth + x) * 4;
      out[o] = Math.round(255 * (r * inverse) ** (1 / 2.2));
      out[o + 1] = Math.round(255 * (g * inverse) ** (1 / 2.2));
      out[o + 2] = Math.round(255 * (b * inverse) ** (1 / 2.2));
      out[o + 3] = Math.round(a * inverse);
    }
  }
  return out;
}

/** Nearest-neighbour zoom of a rect — the only honest way to look at a 1 px ring. */
function cropZoom(rgba, width, height, rect) {
  const { x, y, w, h, scale } = rect;
  const out = Buffer.alloc(w * scale * h * scale * 4);
  for (let dy = 0; dy < h * scale; dy++) {
    const sy = Math.min(height - 1, Math.max(0, y + Math.floor(dy / scale)));
    for (let dx = 0; dx < w * scale; dx++) {
      const sx = Math.min(width - 1, Math.max(0, x + Math.floor(dx / scale)));
      const i = (sy * width + sx) * 4;
      const o = (dy * w * scale + dx) * 4;
      out[o] = rgba[i];
      out[o + 1] = rgba[i + 1];
      out[o + 2] = rgba[i + 2];
      out[o + 3] = rgba[i + 3];
    }
  }
  return { rgba: out, width: w * scale, height: h * scale };
}

/**
 * Captures every error the device reports, from both channels, for the lifetime
 * of the run. THIS is the primary "did the render actually work" signal.
 *
 * Two channels, because a broken shader shows up on both and neither one alone
 * is enough:
 *
 *  - `gpu.onError` — vgpu's own channel. Pipeline creation runs inside a
 *    validation error scope, so `CreateRenderPipeline` failures arrive here as
 *    `VGPU-COMPILE-FAILED`. Crucially, with NO listener registered vgpu just
 *    `console.error`s them and carries on: the frame is submitted with an
 *    invalid pipeline, the target keeps its clear colour, and the harness used
 *    to print `mean=0 std=0` and exit 0.
 *  - the device's `uncapturederror` channel — `createShaderModule` is NOT inside
 *    a vgpu error scope, so the WGSL diagnostic itself (with Dawn's line number
 *    and caret) lands here. With no listener the Node binding prints it to
 *    stdout and nothing else happens, which is how the real message got lost.
 *
 * Both listeners are attached because dawn.node delivers to `addEventListener`
 * AND to `onuncapturederror`, and relying on only one of them would be a bet.
 * The same error object arriving twice is dropped by identity; a genuinely
 * repeated error (the same broken pipeline across several views) is collapsed by
 * text into one entry with a count.
 */
function watchGpuErrors(gpu) {
  const errors = [];
  const byKey = new Map();
  const delivered = new WeakSet();
  const record = (channel, raw) => {
    if (raw !== null && typeof raw === 'object') {
      if (delivered.has(raw)) return;
      delivered.add(raw);
    }
    const text = describeGpuError(raw);
    const key = `${channel}\n${text}`;
    const existing = byKey.get(key);
    if (existing) { existing.count++; return; }
    const entry = { channel, text, count: 1 };
    byKey.set(key, entry);
    errors.push(entry);
  };

  const releases = [];
  releases.push(gpu.onError((error) => record('vgpu', error)));

  const device = gpu.gpu;
  const onUncaptured = (event) => record('device', event?.error ?? event);
  if (typeof device.addEventListener === 'function') {
    device.addEventListener('uncapturederror', onUncaptured);
    releases.push(() => device.removeEventListener?.('uncapturederror', onUncaptured));
  }
  const previous = device.onuncapturederror;
  device.onuncapturederror = onUncaptured;
  releases.push(() => { device.onuncapturederror = previous ?? null; });

  return { errors, release() { for (const undo of releases) { try { undo(); } catch { /* teardown is best effort */ } } } };
}

/** Flattens a `VGPUError` or a native `GPUError` into something worth printing. */
function describeGpuError(error) {
  if (error === null || error === undefined) return 'unknown GPU error';
  if (typeof error !== 'object') return String(error);
  const name = error.name ?? error.constructor?.name ?? 'Error';
  const where = [error.code, error.where].filter(Boolean).join(' @ ');
  const lines = [`${name}${where ? ` [${where}]` : ''}: ${String(error.message ?? error).trim()}`];
  if (error.fix) lines.push(`fix: ${error.fix}`);
  if (error.detail && typeof error.detail === 'object') lines.push(`detail: ${JSON.stringify(error.detail)}`);
  // The interesting text — Dawn's WGSL diagnostic — hangs off `cause` when vgpu
  // wrapped a native GPUValidationError, so never drop it.
  const cause = error.cause;
  if (cause !== null && cause !== undefined) {
    const causeMessage = typeof cause === 'object' ? (cause.message ?? cause.stack ?? '') : String(cause);
    if (String(causeMessage).trim()) lines.push(`cause (${cause?.constructor?.name ?? typeof cause}): ${String(causeMessage).trim()}`);
  }
  return lines.join('\n');
}

/**
 * Waits until every error the device is going to report has been delivered.
 *
 * `gpu.settled()` drains vgpu's tracked work (including the `popErrorScope`
 * promises pipeline creation opened). The extra macrotask turn gives dawn.node's
 * `uncapturederror` callbacks — which are not part of `settled()` — a chance to
 * land before the harness decides its exit code.
 */
async function flushGpuErrors(gpu) {
  await gpu.settled();
  await new Promise((done) => setTimeout(done, 0));
  await gpu.settled();
}

/** True when every RGB byte is 0. Alpha is ignored: the target is cleared to opaque black. */
function isAllBlack(rgba) {
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i] !== 0 || rgba[i + 1] !== 0 || rgba[i + 2] !== 0) return false;
  }
  return true;
}

function stats(rgba) {
  let sum = 0;
  let sumSquares = 0;
  let count = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    const luma = (0.2126 * rgba[i] + 0.7152 * rgba[i + 1] + 0.0722 * rgba[i + 2]) / 255;
    sum += luma;
    sumSquares += luma * luma;
    count++;
  }
  const mean = sum / Math.max(count, 1);
  return { mean: Number(mean.toFixed(4)), std: Number(Math.sqrt(Math.max(sumSquares / Math.max(count, 1) - mean * mean, 0)).toFixed(4)) };
}

async function main() {
  const { options, patch } = parseArgs(process.argv.slice(2));
  const settings = deepMerge(structuredClone(DEFAULT_SETTINGS), patch);
  const names = options.views.includes('all') ? Object.keys(VIEWS) : options.views;
  for (const name of names) {
    if (!(name in VIEWS)) throw new Error(`unknown view "${name}"; expected ${Object.keys(VIEWS).join(', ')} or all`);
  }

  const [bakeWgsl, refineWgsl, shadeWgsl] = await Promise.all([
    loadShader('bake.wgsl'),
    loadShader('refine.wgsl'),
    loadShader('shade.wgsl'),
  ]);

  await mkdir(options.out, { recursive: true });
  const gpu = await init();
  // Attached before anything exists on the device, so no error can predate the
  // listener. This is what turns a silently broken shader into exit 1.
  const watcher = watchGpuErrors(gpu);
  const cleanups = [];
  let outcome;
  let thrown;
  try {
    outcome = await renderViews(gpu, options, settings, names, { bakeWgsl, refineWgsl, shadeWgsl }, cleanups);
  } catch (error) {
    // Do not rethrow: the GPU errors collected below are usually the root cause
    // (a shader that failed to compile makes reflection wrong, and the wrong
    // reflection is what throws), and they must be printed with it.
    thrown = error;
  } finally {
    // Drain before dispose: once the kernel is disposed it drops undelivered
    // error reports, which is one of the ways the original failure got lost.
    try { await flushGpuErrors(gpu); } catch { /* nothing left to flush */ }
    for (const cleanup of cleanups) { try { cleanup(); } catch { /* best effort */ } }
    watcher.release();
    // Always: leaving the device alive keeps Dawn's handles open and the process
    // hangs instead of reporting the failure it just found.
    gpu.dispose();
  }
  return report(options, settings, outcome, thrown, watcher.errors);
}

/**
 * Renders every requested view. Registers its own teardown in `cleanups` so the
 * caller can dispose the device even when this throws half way through.
 */
async function renderViews(gpu, options, settings, names, shaders, cleanups) {
  const { bakeWgsl, refineWgsl, shadeWgsl } = shaders;
  // True SSAA: the BAKE runs at the supersampled resolution too, so every
  // sub-sample is a real geodesic. That is what makes `--ssaa 3` a reference the
  // photon-ring antialiasing can be judged against rather than a post filter.
  const [outWidth, outHeight] = options.size;
  const ssaa = options.ssaa;
  const width = outWidth * ssaa;
  const height = outHeight * ssaa;

  const gbuffer = vgpu.target(gpu, {
    size: [width, height],
    colors: GBUFFER_FORMATS.map((format) => ({ format })),
    label: 'hero-debug-gbuffer',
  });
  // Photon-ring AA data: one-shot, written by the refine pass right after the
  // bake, read 1:1 by shade. Same size as the G-buffer, 10 B/px: 2 for
  // (coverage, span) plus 8 for the synthesized crossing of the sub-pixel arcs
  // that live inside the shadow silhouette.
  const aaTarget = vgpu.target(gpu, {
    size: [width, height],
    colors: AA_FORMATS.map((format) => ({ format })),
    label: 'hero-debug-aa',
  });
  // Display-referred, exactly what the swap chain gets in the browser: shade
  // tone maps in place, so this is the only pass target after the G-buffer.
  const output = vgpu.target(gpu, { size: [width, height], format: 'rgba8unorm', label: 'hero-debug-output' });

  const bake = vgpu.effect(gpu, bakeWgsl, { label: 'hero-debug-bake' });
  const refine = vgpu.effect(gpu, refineWgsl, { label: 'hero-debug-refine' });
  // The same shade.wgsl the browser renderer compiles, from the same imports:
  // a PNG from this harness and a frame from the page are the same program.
  const shade = vgpu.effect(gpu, shadeWgsl, { label: 'hero-debug-shade' });

  // Same lattice bytes the browser uploads (shared module, not a copy), so the
  // harness renders the disk the page renders. Node/Dawn takes the 3D texture
  // and the trilinear repeat sampler through the identical core WebGPU path.
  const noiseVolume = createNoiseVolume(gpu, options.noiseSize, 'hero-debug-noise-volume');
  cleanups.push(() => noiseVolume.destroy());
  const noiseSampler = noiseVolumeSampler(vgpu, gpu);

  const [hit1Texture, hit2Texture, skyTexture, viewTexture] = gbuffer.colors;
  const [aaTexture, aaGeomTexture] = aaTarget.colors;
  const geometry = {
    resolution: gbuffer.size,
    // Camera yaw. The page always bakes with 0 and rotates the scene in the frame
    // pass instead; this exists only as the ground truth for that rotation.
    yaw: options.bakeYaw,
    pitch: settings.cameraY,
    orbitRadius: settings.distance,
    diskOuter: settings.diskRadius,
    fov: settings.fov,
    centerY: settings.centerY,
  };
  // One geometry description for both one-shot passes, exactly like renderer.ts:
  // the sub-rays must come from the same camera as the centre rays.
  bake.set({ bake: geometry });
  refine.set({ gHit1: hit1Texture, gSky: skyTexture, refine: geometry });
  shade.set({
    gHit1: hit1Texture,
    gHit2: hit2Texture,
    gSky: skyTexture,
    gView: viewTexture,
    gAa: aaTexture,
    gAaGeom: aaGeomTexture,
    noiseVolume,
    noiseSampler,
    disk: settings.disk,
    stars: settings.stars,
  });

  // One bake (and one refine) for every view: that is the whole point of the
  // split. The refine pass reads the G-buffer, so it goes in the same frame,
  // after it — the same ordering renderer.ts uses.
  vgpu.frame(gpu, (frame) => {
    frame.pass({ target: gbuffer, clear: [0, 0, 0, 1] }, (pass) => pass.draw(bake));
    frame.pass({ target: aaTarget, clear: [0, 0, 0, 1] }, (pass) => pass.draw(refine));
  });

  const results = [];
  for (const name of names) {
    const debugView = VIEWS[name];
    shade.set({ shade: {
      resolution: output.size,
      time: options.time,
      diskOuter: settings.diskRadius,
      debugView,
      diskLayers: settings.diskLayers,
      aa: settings.aa,
      // Instantaneous scene rotation; the browser smooths it from the pointer.
      sceneYaw: options.yaw,
    } });
    // No composite uniform: the debug bypass is an early return inside
    // shade.wgsl, so `debugView` alone decides whether the tone map runs.
    vgpu.frame(gpu, (frame) => {
      frame.pass({ target: output, clear: [0, 0, 0, 1] }, (pass) => pass.draw(shade));
    });
    const rendered = await output.read();
    // At --ssaa 1 this is the identity (same Buffer), so the shipped path stays
    // bit-for-bit what it always was.
    const pixels = downsampleLinear(rendered, width, height, ssaa);
    const path = join(options.out, `${name}.png`);
    await writePng(path, outWidth, outHeight, pixels);
    // `black` feeds the secondary guard: an all-black view is what a shader that
    // failed to compile leaves behind, because the pass never overwrote the clear.
    const result = { view: name, debugView, path, ...stats(pixels), black: isAllBlack(pixels) };
    if (options.crop) {
      const zoom = cropZoom(pixels, outWidth, outHeight, options.crop);
      result.crop = join(options.out, `${name}-crop.png`);
      await writePng(result.crop, zoom.width, zoom.height, zoom.rgba);
    }
    results.push(result);
  }

  return { results, outWidth, outHeight, width, height, ssaa };
}

/**
 * Prints the run and decides the exit code. Returns 0 only when every requested
 * view rendered, nothing threw, and the device reported no error.
 */
function report(options, settings, outcome, thrown, gpuErrors) {
  const results = outcome?.results ?? [];
  const requested = options.views.includes('all') ? Object.keys(VIEWS).length : options.views.length;
  const blackViews = options.allowBlack ? [] : results.filter((result) => result.black).map((result) => result.view);
  // Primary: a real error from the device. Secondary: the black-image guard, and
  // only when no error already explains the run — a black frame on its own is not
  // proof of a bug (`--disk.brightness 0 --stars.brightness 0` is honestly black).
  const failed = gpuErrors.length > 0 || thrown !== undefined || blackViews.length > 0 || results.length < requested;

  if (options.json) {
    console.log(JSON.stringify({
      ok: !failed,
      size: options.size,
      ssaa: outcome?.ssaa ?? options.ssaa,
      time: options.time,
      noiseSize: options.noiseSize,
      settings,
      images: results,
      gpuErrors: gpuErrors.map((entry) => ({ channel: entry.channel, count: entry.count, message: entry.text })),
      thrown: thrown === undefined ? undefined : String(thrown?.stack ?? thrown),
      blackViews,
    }, null, 2));
  } else {
    if (outcome) {
      console.log(`hero debug render ${outcome.outWidth}x${outcome.outHeight} (ssaa ${outcome.ssaa}x -> rendered ${outcome.width}x${outcome.height}) @ t=${options.time}s noise=${options.noiseSize}^3 -> ${options.out}`);
    }
    for (const result of results) {
      console.log(`  ${result.view.padEnd(8)} debugView=${result.debugView}  mean=${result.mean}  std=${result.std}  ${result.path}`);
    }
  }

  if (!failed) return 0;

  // Everything below goes to stderr, verbatim and unabridged. The whole point of
  // the exit code is that nobody has to go looking for this.
  const rule = '='.repeat(78);
  console.error(`\n${rule}\n hero debug render FAILED — the images above are NOT trustworthy\n${rule}`);
  if (gpuErrors.length) {
    console.error(` the GPU reported ${gpuErrors.length} distinct error(s):\n`);
    gpuErrors.forEach((entry, index) => {
      console.error(`  [${index + 1}] ${entry.channel} channel${entry.count > 1 ? ` (x${entry.count})` : ''}:`);
      for (const line of entry.text.split('\n')) console.error(`      ${line}`);
      console.error('');
    });
  }
  if (thrown !== undefined) {
    console.error(' the harness itself threw:\n');
    for (const line of String(thrown?.stack ?? thrown).split('\n')) console.error(`      ${line}`);
    console.error('');
  }
  if (blackViews.length) {
    console.error(` every pixel of ${blackViews.length === 1 ? 'view' : 'views'} ${blackViews.map((view) => `"${view}"`).join(', ')} is black.`);
    console.error(gpuErrors.length
      ? '      Expected, given the GPU errors above: the pass never overwrote the clear colour.'
      : '      No GPU error explains it, so either a shader produced nothing or the settings\n      genuinely render black (e.g. --disk.brightness 0 --stars.brightness 0).\n      Re-run with --allow-black if the black image is what you asked for.');
    console.error('');
  }
  if (results.length < requested) {
    console.error(` only ${results.length} of ${requested} requested view(s) were written.\n`);
  }
  console.error(`${rule}\n hero debug render FAILED (exit 1)\n${rule}`);
  return 1;
}

main().then(
  (code) => { process.exitCode = code; },
  (error) => {
    console.error(error);
    process.exitCode = 1;
  },
);
