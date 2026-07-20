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

  prewarm(effects, targets, surface);

  let sawInitialResize = false;
  const unsubscribeResize = surface.onResize(() => {
    if (!sawInitialResize) {
      sawInitialResize = true;
      return;
    }
    if (disposed) return;
    destroyTargets(targets);
    targets = createTargets(gpu, surface.size, 'post-processing-live');
    prewarm(effects, targets, surface);
  });

  const handle = gpu.frame.loop((frame) => {
    renderChain(frame, effects, targets, surface, {
      time: gpu.time,
      flags: controls.getFlags(),
    });
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
  const effects = createEffects(gpu);
  const targets = createTargets(gpu, target.size, 'post-processing-thumb');
  prewarm(effects, targets, target);

  const warmupFrames = opts.warmupFrames ?? 60;
  const dt = opts.dt ?? 1 / 60;
  let time = opts.time ?? 2.0;
  for (let i = 0; i < warmupFrames; i += 1) {
    time += dt;
    gpu.frame((frame) => {
      renderChain(frame, effects, targets, target, {
        time,
        flags: DEFAULT_FLAGS,
      });
    });
  }

  await gpu.gpu.queue.onSubmittedWorkDone();
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

function prewarm(effects: EffectChain, targets: ChainTargets, output: Surface | Target): void {
  effects.scene.compileSync(targets.scene);
  effects.threshold.compileSync(targets.bright);
  effects.blurH.compileSync(targets.blurA);
  effects.blurV.compileSync(targets.blurB);
  effects.grade.compileSync(output);
}

function renderChain(
  frame: Frame,
  effects: EffectChain,
  targets: ChainTargets,
  output: Surface | Target,
  opts: { time: number; flags: PostProcessingFlags },
): void {
  const sceneSize = targets.scene.size;
  const blurSize = targets.blurA.size;
  const outputSize = output.size;

  effects.scene.set({
    uniforms: {
      time: opts.time,
      resolution: sceneSize,
      _pad: 0,
    },
  });
  frame.pass({ target: targets.scene, clear: [0, 0, 0, 1] }, (pass) => pass.draw(effects.scene));

  // The bloom extraction/blur passes are always encoded and final-composite gated by a uniform.
  // This keeps grade bindings stable when the live checkbox is off, trading a little work for simplicity.
  effects.threshold.set({
    uniforms: {
      resolution: blurSize,
      threshold: 0.62,
      knee: 0.34,
    },
    scene_tex: targets.scene,
    linear_samp: effects.sampler,
  });
  frame.pass({ target: targets.bright, clear: [0, 0, 0, 1] }, (pass) => pass.draw(effects.threshold));

  effects.blurH.set({
    uniforms: {
      resolution: blurSize,
      direction: [1, 0],
    },
    source_tex: targets.bright,
    linear_samp: effects.sampler,
  });
  frame.pass({ target: targets.blurA, clear: [0, 0, 0, 1] }, (pass) => pass.draw(effects.blurH));

  effects.blurV.set({
    uniforms: {
      resolution: blurSize,
      direction: [0, 1],
    },
    source_tex: targets.blurA,
    linear_samp: effects.sampler,
  });
  frame.pass({ target: targets.blurB, clear: [0, 0, 0, 1] }, (pass) => pass.draw(effects.blurV));

  effects.grade.set({
    uniforms: {
      resolution: outputSize,
      time: opts.time,
      bloomStrength: 1.45,
      caAmount: 0.010,
      grainAmount: 0.055,
      bloomOn: opts.flags.bloom ? 1 : 0,
      caOn: opts.flags.ca ? 1 : 0,
      grainOn: opts.flags.grain ? 1 : 0,
      _pad: 0,
    },
    scene_tex: targets.scene,
    bloom_tex: targets.blurB,
    linear_samp: effects.sampler,
  });
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
