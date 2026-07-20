import type { Effect, Frame, Gpu, Surface, Target } from 'vgpu';

import blurWgsl from './blur.wgsl';
import gradeWgsl from './grade.wgsl';
import sceneWgsl from './scene.wgsl';
import thresholdWgsl from './threshold.wgsl';
import type { PostProcessingFlags } from './controls';

interface ThumbOptions {
  warmupFrames?: number;
  dt?: number;
  time?: number;
}

interface EffectChain {
  scene: Effect;
  threshold: Effect;
  blurH: Effect;
  blurV: Effect;
  grade: Effect;
  sampler: GPUSampler;
}

interface ChainTargets {
  scene: Target;
  bright: Target;
  blurA: Target;
  blurB: Target;
}

const FORMAT: GPUTextureFormat = 'rgba8unorm';
const DEFAULT_FLAGS: PostProcessingFlags = { bloom: true, ca: true, grain: true };

export async function run(canvas: HTMLCanvasElement): Promise<() => void> {
  const { init } = await import('vgpu');
  const { installControls } = await import('./controls');
  const gpu = await init();
  const surface = gpu.surface(canvas, { dpr: [1, 2] });
  const effects = createEffects(gpu);
  let targets = createTargets(gpu, surface.size, 'post-processing-live');
  const controls = installControls(canvas);
  let disposed = false;

  await prewarm(effects, targets, surface);
  setChainConstants(effects);
  setChainBindings(effects, targets, surface);
  setGradeFlags(effects.grade, controls.getFlags());
  const unsubscribeFlags = controls.onFlagsChange((flags) => setGradeFlags(effects.grade, flags));

  let sawInitialResize = false;
  const unsubscribeResize = surface.onResize(() => {
    if (!sawInitialResize) {
      sawInitialResize = true;
      return;
    }
    if (disposed) return;
    destroyTargets(targets);
    targets = createTargets(gpu, surface.size, 'post-processing-live');
    setChainBindings(effects, targets, surface);
  });

  const handle = gpu.frame.loop((frame) => {
    renderChain(frame, effects, targets, surface, gpu.time);
  });

  return () => {
    if (disposed) return;
    disposed = true;
    handle.stop();
    unsubscribeResize();
    unsubscribeFlags();
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
  const effects = createEffects(gpu);
  const targets = createTargets(gpu, target.size, 'post-processing-thumb');
  await prewarm(effects, targets, target);
  setChainConstants(effects);
  setChainBindings(effects, targets, target);
  setGradeFlags(effects.grade, DEFAULT_FLAGS);

  const warmupFrames = opts.warmupFrames ?? 60;
  const dt = opts.dt ?? 1 / 60;
  let time = opts.time ?? 2.0;
  for (let i = 0; i < warmupFrames; i += 1) {
    time += dt;
    gpu.frame((frame) => {
      renderChain(frame, effects, targets, target, time);
    });
  }

  await gpu.gpu.queue.onSubmittedWorkDone();
  await gpu.settled();
  destroyTargets(targets);
}

function createEffects(gpu: Gpu): EffectChain {
  return {
    scene: gpu.effect(sceneWgsl, { label: 'post-processing-scene' }),
    threshold: gpu.effect(thresholdWgsl, { label: 'post-processing-threshold' }),
    // Separate effect instances avoid same-frame uniform/bind-group aliasing between blur directions.
    blurH: gpu.effect(blurWgsl, { label: 'post-processing-blur-h' }),
    blurV: gpu.effect(blurWgsl, { label: 'post-processing-blur-v' }),
    grade: gpu.effect(gradeWgsl, { label: 'post-processing-grade' }),
    sampler: gpu.sampler({ minFilter: 'linear', magFilter: 'linear' }),
  };
}

function createTargets(gpu: Gpu, size: readonly [number, number], label: string): ChainTargets {
  const full = normalizeSize(size);
  const half = halfSize(full);
  return {
    scene: gpu.target({ size: full, format: FORMAT, label: `${label}-scene` }),
    bright: gpu.target({ size: half, format: FORMAT, label: `${label}-bright` }),
    blurA: gpu.target({ size: half, format: FORMAT, label: `${label}-blur-a` }),
    blurB: gpu.target({ size: half, format: FORMAT, label: `${label}-blur-b` }),
  };
}

async function prewarm(effects: EffectChain, targets: ChainTargets, output: Surface | Target): Promise<void> {
  await Promise.all([
    effects.scene.compile(targets.scene),
    effects.threshold.compile(targets.bright),
    effects.blurH.compile(targets.blurA),
    effects.blurV.compile(targets.blurB),
    effects.grade.compile(output),
  ]);
}

function setChainConstants(effects: EffectChain): void {
  effects.scene.set({ _pad: 0 });
  effects.threshold.set({ threshold: 0.62, knee: 0.34, linear_samp: effects.sampler });
  effects.blurH.set({ direction: [1, 0], linear_samp: effects.sampler });
  effects.blurV.set({ direction: [0, 1], linear_samp: effects.sampler });
  effects.grade.set({
    bloomStrength: 1.45,
    caAmount: 0.010,
    grainAmount: 0.055,
    _pad: 0,
    linear_samp: effects.sampler,
  });
}

function setChainBindings(effects: EffectChain, targets: ChainTargets, output: Surface | Target): void {
  const sceneSize = targets.scene.size;
  const blurSize = targets.blurA.size;

  effects.scene.set({ resolution: sceneSize });
  effects.threshold.set({ resolution: blurSize, scene_tex: targets.scene });
  effects.blurH.set({ resolution: blurSize, source_tex: targets.bright });
  effects.blurV.set({ resolution: blurSize, source_tex: targets.blurA });
  effects.grade.set({ resolution: output.size, scene_tex: targets.scene, bloom_tex: targets.blurB });
}

function setGradeFlags(grade: Effect, flags: PostProcessingFlags): void {
  grade.set({
    bloomOn: flags.bloom ? 1 : 0,
    caOn: flags.ca ? 1 : 0,
    grainOn: flags.grain ? 1 : 0,
  });
}

function renderChain(
  frame: Frame,
  effects: EffectChain,
  targets: ChainTargets,
  output: Surface | Target,
  time: number,
): void {
  effects.scene.set({ time });
  frame.pass({ target: targets.scene, clear: [0, 0, 0, 1] }, (pass) => pass.draw(effects.scene));

  // The bloom extraction/blur passes are always encoded and final-composite gated by a uniform.
  // This keeps grade bindings stable when the live checkbox is off, trading a little work for simplicity.
  frame.pass({ target: targets.bright, clear: [0, 0, 0, 1] }, (pass) => pass.draw(effects.threshold));
  frame.pass({ target: targets.blurA, clear: [0, 0, 0, 1] }, (pass) => pass.draw(effects.blurH));
  frame.pass({ target: targets.blurB, clear: [0, 0, 0, 1] }, (pass) => pass.draw(effects.blurV));

  effects.grade.set({ time });
  frame.pass({ target: output, clear: [0, 0, 0, 1] }, (pass) => pass.draw(effects.grade));
}

function normalizeSize(size: readonly [number, number]): readonly [number, number] {
  return [Math.max(1, Math.floor(size[0])), Math.max(1, Math.floor(size[1]))];
}

function halfSize(size: readonly [number, number]): readonly [number, number] {
  return [Math.max(1, Math.ceil(size[0] / 2)), Math.max(1, Math.ceil(size[1] / 2))];
}

function destroyTargets(targets: ChainTargets): void {
  for (const target of [targets.scene, targets.bright, targets.blurA, targets.blurB]) {
    (target as Target & { destroy?: () => void }).destroy?.();
  }
}
