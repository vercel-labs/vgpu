import type { Gpu, Surface, Target } from 'vgpu';
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

interface AaTargets {
  readonly msaa: Target;
  readonly ssaa: Target;
  readonly ldr: Target;
}

const FORMAT: GPUTextureFormat = 'rgba8unorm';
const CLEAR_BLACK: readonly [number, number, number, number] = [0, 0, 0, 1];

export async function run(canvas: HTMLCanvasElement): Promise<() => void> {
  const { init } = await import('vgpu');
  const gpu = await init();
  const surface = gpu.surface(canvas, { dpr: [1, 2] });
  const scene = gpu.effect(sceneWgsl, { label: 'anti-aliasing-scene' });
  const resolve = gpu.effect(resolveWgsl, { label: 'anti-aliasing-resolve' });
  const fxaa = gpu.effect(fxaaWgsl, { label: 'anti-aliasing-fxaa' });
  const sampler = gpu.sampler({
    minFilter: 'linear',
    magFilter: 'linear',
    addressModeU: 'clamp-to-edge',
    addressModeV: 'clamp-to-edge',
  });

  let targets = createTargets(gpu, surface.size);
  const controls = installControls(canvas);
  let disposed = false;
  let sawInitialResize = false;

  prewarm({ scene, resolve, fxaa, surface, targets });

  const unsubscribeResize = surface.onResize(() => {
    if (!sawInitialResize) {
      sawInitialResize = true;
      return;
    }
    if (disposed) return;
    resizeTargets(targets, surface.size);
    prewarm({ scene, resolve, fxaa, surface, targets });
  });

  const handle = gpu.frame.loop((frame) => {
    const mode = controls.getMode();
    const time = gpu.time;

    if (mode === AA_MODE_OFF) {
      setScene(scene, time, surface.size);
      frame.pass({ target: surface, clear: CLEAR_BLACK }, (pass) => pass.draw(scene));
      return;
    }

    if (mode === AA_MODE_MSAA_4X) {
      setScene(scene, time, targets.msaa.size);
      setResolve(resolve, targets.msaa, surface.size, 0, sampler);
      frame.pass({ target: targets.msaa, clear: CLEAR_BLACK }, (pass) => pass.draw(scene));
      frame.pass({ target: surface, clear: CLEAR_BLACK }, (pass) => pass.draw(resolve));
      return;
    }

    if (mode === AA_MODE_SSAA_2X) {
      setScene(scene, time, targets.ssaa.size);
      setResolve(resolve, targets.ssaa, surface.size, 1, sampler);
      frame.pass({ target: targets.ssaa, clear: CLEAR_BLACK }, (pass) => pass.draw(scene));
      frame.pass({ target: surface, clear: CLEAR_BLACK }, (pass) => pass.draw(resolve));
      return;
    }

    setScene(scene, time, targets.ldr.size);
    setFxaa(fxaa, targets.ldr, surface.size, sampler);
    frame.pass({ target: targets.ldr, clear: CLEAR_BLACK }, (pass) => pass.draw(scene));
    frame.pass({ target: surface, clear: CLEAR_BLACK }, (pass) => pass.draw(fxaa));
  });

  return () => {
    if (disposed) return;
    disposed = true;
    handle.stop();
    unsubscribeResize();
    controls.dispose();
    surface.dispose();
    gpu.dispose();
  };
}

export async function renderThumb(
  gpu: Gpu,
  target: Target,
  opts: ThumbOptions = {},
): Promise<void> {
  const scene = gpu.effect(sceneWgsl, { label: 'anti-aliasing-thumb-scene' });
  const fxaa = gpu.effect(fxaaWgsl, { label: 'anti-aliasing-thumb-fxaa' });
  const sampler = gpu.sampler({
    minFilter: 'linear',
    magFilter: 'linear',
    addressModeU: 'clamp-to-edge',
    addressModeV: 'clamp-to-edge',
  });
  const ldr = gpu.target({
    size: normalizedSize(target.size),
    format: FORMAT,
    label: 'anti-aliasing-thumb-ldr',
  });

  scene.compileSync(ldr);
  setFxaa(fxaa, ldr, target.size, sampler);
  fxaa.compileSync(target);

  const warmupFrames = Math.max(1, opts.warmupFrames ?? 60);
  const dt = opts.dt ?? 1 / 60;
  let time = opts.time ?? 1.2;

  for (let i = 0; i < warmupFrames; i++) {
    time += dt;
    gpu.frame((frame) => {
      setScene(scene, time, ldr.size);
      setFxaa(fxaa, ldr, target.size, sampler);
      frame.pass({ target: ldr, clear: CLEAR_BLACK }, (pass) => pass.draw(scene));
      frame.pass({ target, clear: CLEAR_BLACK }, (pass) => pass.draw(fxaa));
    });
  }

  await gpu.gpu.queue.onSubmittedWorkDone();
}

function createTargets(gpu: Gpu, size: readonly [number, number]): AaTargets {
  const [width, height] = normalizedSize(size);
  return {
    // Dawn compat in Docker rejects rgba16float+MSAA, so every AA intermediate is rgba8unorm.
    msaa: gpu.target({ size: [width, height], format: FORMAT, msaa: true, label: 'anti-aliasing-msaa-4x' }),
    ssaa: gpu.target({ size: [width * 2, height * 2], format: FORMAT, label: 'anti-aliasing-ssaa-2x' }),
    ldr: gpu.target({ size: [width, height], format: FORMAT, label: 'anti-aliasing-fxaa-ldr' }),
  };
}

function resizeTargets(targets: AaTargets, size: readonly [number, number]): void {
  const [width, height] = normalizedSize(size);
  targets.msaa.resize([width, height]);
  targets.ssaa.resize([width * 2, height * 2]);
  targets.ldr.resize([width, height]);
}

function prewarm(opts: {
  scene: ReturnType<Gpu['effect']>;
  resolve: ReturnType<Gpu['effect']>;
  fxaa: ReturnType<Gpu['effect']>;
  surface: Surface;
  targets: AaTargets;
}): void {
  opts.scene.compileSync(opts.surface);
  opts.scene.compileSync(opts.targets.msaa);
  opts.scene.compileSync(opts.targets.ssaa);
  opts.scene.compileSync(opts.targets.ldr);
  opts.resolve.compileSync(opts.surface);
  opts.fxaa.compileSync(opts.surface);
}

function setScene(
  scene: ReturnType<Gpu['effect']>,
  time: number,
  resolution: readonly [number, number],
): void {
  scene.set({ uniforms: { time, resolution, _pad: 0 } });
}

function setResolve(
  resolve: ReturnType<Gpu['effect']>,
  source: Target,
  resolution: readonly [number, number],
  kind: 0 | 1,
  sampler: GPUSampler,
): void {
  resolve.set({
    uniforms: { resolution, kind, _pad: 0 },
    scene_tex: source,
    linear_samp: sampler,
  });
}

function setFxaa(
  fxaa: ReturnType<Gpu['effect']>,
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
