import type { Effect, Frame, Gpu, Surface, Target } from 'vgpu';
import {
  AA_MODE_FXAA,
  AA_MODE_MSAA_4X,
  AA_MODE_OFF,
  AA_MODE_SSAA_2X,
  installControls,
  type AaMode,
} from './controls';
import sceneWgsl from './scene.wgsl';
import resolveWgsl from './resolve.wgsl';
import fxaaWgsl from './fxaa.wgsl';

interface ThumbOptions {
  warmupFrames?: number;
  dt?: number;
  time?: number;
}

interface AaEffects {
  readonly scene: Effect;
  readonly resolve: Effect;
  readonly fxaa: Effect;
  readonly sampler: GPUSampler;
}

interface AaTargets {
  readonly msaa: Target;
  readonly ssaa: Target;
  readonly ldr: Target;
}

const FORMAT: GPUTextureFormat = 'rgba8unorm';
const CLEAR_BLACK: readonly [number, number, number, number] = [0, 0, 0, 1];
const ALL_MODES: readonly AaMode[] = [AA_MODE_OFF, AA_MODE_MSAA_4X, AA_MODE_SSAA_2X, AA_MODE_FXAA];

export async function run(canvas: HTMLCanvasElement): Promise<() => void> {
  const { init } = await import('vgpu');
  const gpu = await init();
  const surface = gpu.surface(canvas, { dpr: [1, 2] });
  const effects = createEffects(gpu, 'anti-aliasing');
  const targets = createTargets(gpu, surface.size, 'anti-aliasing');
  const controls = installControls(canvas);
  let disposed = false;
  let sawInitialResize = false;

  // Compile every target signature before the frame loop so mode changes never compile lazily.
  await prewarm(effects, targets, surface);

  const unsubscribeResize = surface.onResize(() => {
    if (!sawInitialResize) {
      sawInitialResize = true;
      return;
    }
    if (disposed) return;
    resizeTargets(targets, surface.size);
  });

  const handle = gpu.frame.loop((frame) => {
    renderMode(frame, effects, targets, surface, controls.getMode(), gpu.time);
  });

  return () => {
    if (disposed) return;
    disposed = true;
    handle.stop();
    unsubscribeResize();
    controls.dispose();
    destroyTargets(targets);
    surface.dispose();
    gpu.dispose();
  };
}

export async function renderThumb(
  gpu: Gpu,
  target: Target,
  opts: ThumbOptions = {},
): Promise<void> {
  const effects = createEffects(gpu, 'anti-aliasing-thumb');
  const targets = createTargets(gpu, target.size, 'anti-aliasing-thumb');
  await prewarm(effects, targets, target);

  const dt = opts.dt ?? 1 / 60;
  let time = opts.time ?? 1.2;

  // The gallery normally ends on FXAA, but exercise every mode first so Docker validates
  // all lazily-selected pipelines (including the 4x sample-count variant) and bindings.
  for (const mode of ALL_MODES) {
    gpu.frame((frame) => renderMode(frame, effects, targets, target, mode, time));
  }

  const warmupFrames = Math.max(1, opts.warmupFrames ?? 60);
  for (let i = 0; i < warmupFrames; i++) {
    time += dt;
    gpu.frame((frame) => renderMode(frame, effects, targets, target, AA_MODE_FXAA, time));
  }

  await gpu.gpu.queue.onSubmittedWorkDone();
  await gpu.settled();
  destroyTargets(targets);
}

function createEffects(gpu: Gpu, label: string): AaEffects {
  return {
    scene: gpu.effect(sceneWgsl, { label: `${label}-scene` }),
    resolve: gpu.effect(resolveWgsl, { label: `${label}-resolve` }),
    fxaa: gpu.effect(fxaaWgsl, { label: `${label}-fxaa` }),
    sampler: gpu.sampler({
      minFilter: 'linear',
      magFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    }),
  };
}

function createTargets(gpu: Gpu, size: readonly [number, number], label: string): AaTargets {
  const [width, height] = normalizedSize(size);
  return {
    // Dawn compat in Docker rejects rgba16float+MSAA, so every AA intermediate is rgba8unorm.
    msaa: gpu.target({ size: [width, height], format: FORMAT, msaa: true, label: `${label}-msaa-4x` }),
    ssaa: gpu.target({ size: [width * 2, height * 2], format: FORMAT, label: `${label}-ssaa-2x` }),
    ldr: gpu.target({ size: [width, height], format: FORMAT, label: `${label}-fxaa-ldr` }),
  };
}

function resizeTargets(targets: AaTargets, size: readonly [number, number]): void {
  const [width, height] = normalizedSize(size);
  targets.msaa.resize([width, height]);
  targets.ssaa.resize([width * 2, height * 2]);
  targets.ldr.resize([width, height]);
}

async function prewarm(
  effects: AaEffects,
  targets: AaTargets,
  output: Surface | Target,
): Promise<void> {
  await Promise.all([
    effects.scene.compile(output),
    effects.scene.compile(targets.msaa),
    effects.scene.compile(targets.ssaa),
    effects.scene.compile(targets.ldr),
    effects.resolve.compile(output),
    effects.fxaa.compile(output),
  ]);
}

function renderMode(
  frame: Frame,
  effects: AaEffects,
  targets: AaTargets,
  output: Surface | Target,
  mode: AaMode,
  time: number,
): void {
  if (mode === AA_MODE_OFF) {
    setScene(effects.scene, time, output.size);
    frame.pass({ target: output, clear: CLEAR_BLACK }, (pass) => pass.draw(effects.scene));
    return;
  }

  if (mode === AA_MODE_MSAA_4X) {
    setScene(effects.scene, time, targets.msaa.size);
    setResolve(effects.resolve, targets.msaa, output.size, 0);
    frame.pass({ target: targets.msaa, clear: CLEAR_BLACK }, (pass) => pass.draw(effects.scene));
    frame.pass({ target: output, clear: CLEAR_BLACK }, (pass) => pass.draw(effects.resolve));
    return;
  }

  if (mode === AA_MODE_SSAA_2X) {
    setScene(effects.scene, time, targets.ssaa.size);
    setResolve(effects.resolve, targets.ssaa, output.size, 1);
    frame.pass({ target: targets.ssaa, clear: CLEAR_BLACK }, (pass) => pass.draw(effects.scene));
    frame.pass({ target: output, clear: CLEAR_BLACK }, (pass) => pass.draw(effects.resolve));
    return;
  }

  setScene(effects.scene, time, targets.ldr.size);
  setFxaa(effects.fxaa, targets.ldr, output.size, effects.sampler);
  frame.pass({ target: targets.ldr, clear: CLEAR_BLACK }, (pass) => pass.draw(effects.scene));
  frame.pass({ target: output, clear: CLEAR_BLACK }, (pass) => pass.draw(effects.fxaa));
}

function setScene(
  scene: Effect,
  time: number,
  resolution: readonly [number, number],
): void {
  scene.set({ uniforms: { time, resolution, _pad: 0 } });
}

function setResolve(
  resolve: Effect,
  source: Target,
  resolution: readonly [number, number],
  kind: 0 | 1,
): void {
  resolve.set({
    uniforms: { resolution, kind, _pad: 0 },
    scene_tex: source,
  });
}

function setFxaa(
  fxaa: Effect,
  source: Target,
  resolution: readonly [number, number],
  sampler: GPUSampler,
): void {
  fxaa.set({
    uniforms: {
      resolution,
      edge_threshold: 0.166,
      edge_threshold_min: 0.0833,
      subpix: 0.75,
      _pad0: 0,
      _pad1: 0,
      _pad2: 0,
    },
    scene_tex: source,
    linear_samp: sampler,
  });
}

function normalizedSize(size: readonly [number, number]): [number, number] {
  return [Math.max(1, Math.floor(size[0])), Math.max(1, Math.floor(size[1]))];
}

function destroyTargets(targets: AaTargets): void {
  for (const target of [targets.msaa, targets.ssaa, targets.ldr]) {
    (target as Target & { destroy?: () => void }).destroy?.();
  }
}
