import type { Effect, Frame, Gpu, Surface, Target } from 'vgpu';

import blackHoleWgsl from './black-hole.wgsl';
import blurWgsl from './blur.wgsl';
import brightPassWgsl from './bright-pass.wgsl';
import compositeWgsl from './composite.wgsl';

type Output = Surface | Target;
type Orbit = readonly [number, number];

interface ThumbOptions {
  time?: number;
  onVariantRendered?: (
    variant: 'time-delta' | 'pointer-orbit',
    pixels: Uint8Array,
    size: readonly [number, number],
  ) => void | Promise<void>;
}

interface Effects {
  scene: Effect;
  brightPass: Effect;
  blurH1: Effect;
  blurV1: Effect;
  blurH2: Effect;
  blurV2: Effect;
  composite: Effect;
  sampler: GPUSampler;
}

interface Targets {
  scene: Target;
  bloomA: Target;
  bloomB: Target;
}

const HDR_FORMAT: GPUTextureFormat = 'rgba16float';
const BLOOM_HEIGHT = 360;
const CLEAR: readonly [number, number, number, number] = [0, 0, 0, 1];

export async function run(canvas: HTMLCanvasElement): Promise<() => void> {
  const { init } = await import('vgpu');
  const gpu = await init();
  const surface = gpu.surface(canvas, { dpr: [1, 1.6] });
  const effects = createEffects(gpu, 'black-hole-live');
  const targets = createTargets(gpu, surface.size, 'black-hole-live');
  const input = installOrbitInput(canvas);
  let disposed = false;

  setConstants(effects);
  setBindings(effects, targets, surface);
  await prewarm(effects, targets, surface);

  let sawInitialResize = false;
  const unsubscribeResize = surface.onResize(() => {
    if (!sawInitialResize) {
      sawInitialResize = true;
      return;
    }
    if (disposed) return;
    resizeTargets(targets, surface.size);
    setBindings(effects, targets, surface);
  });

  const handle = gpu.frame.loop((frame) => {
    const pointer = input.update();
    // Keep per-frame writes limited to the two values that actually animate.
    effects.scene.set({ params: { pointer, time: gpu.time } });
    renderChain(frame, effects, targets, surface);
  });

  return () => {
    if (disposed) return;
    disposed = true;
    handle.stop();
    unsubscribeResize();
    input.dispose();
    surface.dispose();
    gpu.dispose();
  };
}

export async function renderThumb(gpu: Gpu, target: Target, opts: ThumbOptions = {}): Promise<void> {
  const effects = createEffects(gpu, 'black-hole-thumb');
  const targets = createTargets(gpu, target.size, 'black-hole-thumb');
  const time = opts.time ?? 8.5;
  setConstants(effects);
  setBindings(effects, targets, target);
  await prewarm(effects, targets, target);

  renderAt(gpu, effects, targets, target, time, [0, 0.05]);
  await gpu.gpu.queue.onSubmittedWorkDone();

  renderAt(gpu, effects, targets, target, time + 7, [0, 0.05]);
  await gpu.gpu.queue.onSubmittedWorkDone();
  await opts.onVariantRendered?.('time-delta', await target.read(), target.size);

  renderAt(gpu, effects, targets, target, time, [0.72, 0.34]);
  await gpu.gpu.queue.onSubmittedWorkDone();
  await opts.onVariantRendered?.('pointer-orbit', await target.read(), target.size);

  // Leave the deterministic poster framing in the output target.
  renderAt(gpu, effects, targets, target, time, [0, 0.05]);
  await gpu.gpu.queue.onSubmittedWorkDone();
  await gpu.settled();
}

function createEffects(gpu: Gpu, label: string): Effects {
  return {
    scene: gpu.effect(blackHoleWgsl, { label: `${label}-scene` }),
    brightPass: gpu.effect(brightPassWgsl, { label: `${label}-bright-pass` }),
    // Each pass owns its uniform buffer; mutating one effect repeatedly in a frame
    // would make all encoded passes observe the final direction and radius.
    blurH1: gpu.effect(blurWgsl, { label: `${label}-blur-h1` }),
    blurV1: gpu.effect(blurWgsl, { label: `${label}-blur-v1` }),
    blurH2: gpu.effect(blurWgsl, { label: `${label}-blur-h2` }),
    blurV2: gpu.effect(blurWgsl, { label: `${label}-blur-v2` }),
    composite: gpu.effect(compositeWgsl, { label: `${label}-composite` }),
    sampler: gpu.sampler({ minFilter: 'linear', magFilter: 'linear' }),
  };
}

function createTargets(gpu: Gpu, size: readonly [number, number], label: string): Targets {
  const full = normalizeSize(size);
  const bloom = bloomSize(full);
  return {
    scene: gpu.target({ size: full, format: HDR_FORMAT, label: `${label}-scene` }),
    bloomA: gpu.target({ size: bloom, format: HDR_FORMAT, label: `${label}-bloom-a` }),
    bloomB: gpu.target({ size: bloom, format: HDR_FORMAT, label: `${label}-bloom-b` }),
  };
}

function setConstants(effects: Effects): void {
  effects.scene.set({ params: { pointer: [0, 0.05], time: 0, motion: 1 } });
  effects.brightPass.set({ samp: effects.sampler, bright: { threshold: 1, knee: 0.6 } });
  effects.blurH1.set({ samp: effects.sampler, blur: { direction: [1, 0], radius: 1 } });
  effects.blurV1.set({ samp: effects.sampler, blur: { direction: [0, 1], radius: 1 } });
  effects.blurH2.set({ samp: effects.sampler, blur: { direction: [1, 0], radius: 2.4 } });
  effects.blurV2.set({ samp: effects.sampler, blur: { direction: [0, 1], radius: 2.4 } });
  effects.composite.set({ samp: effects.sampler, composite: { exposure: 1.15, bloomStrength: 0.9 } });
}

function setBindings(effects: Effects, targets: Targets, output: Output): void {
  effects.scene.set({ params: { resolution: targets.scene.size } });
  effects.brightPass.set({ src: targets.scene });
  effects.blurH1.set({ src: targets.bloomA, blur: { texelSize: targets.bloomA.texelSize } });
  effects.blurV1.set({ src: targets.bloomB, blur: { texelSize: targets.bloomB.texelSize } });
  effects.blurH2.set({ src: targets.bloomA, blur: { texelSize: targets.bloomA.texelSize } });
  effects.blurV2.set({ src: targets.bloomB, blur: { texelSize: targets.bloomB.texelSize } });
  effects.composite.set({ scene: targets.scene, bloom: targets.bloomA });
  void output;
}

async function prewarm(effects: Effects, targets: Targets, output: Output): Promise<void> {
  await Promise.all([
    effects.scene.compile(targets.scene), effects.brightPass.compile(targets.bloomA),
    effects.blurH1.compile(targets.bloomB), effects.blurV1.compile(targets.bloomA),
    effects.blurH2.compile(targets.bloomB), effects.blurV2.compile(targets.bloomA),
    effects.composite.compile(output),
  ]);
}

function renderChain(frame: Frame, effects: Effects, targets: Targets, output: Output): void {
  frame.pass({ target: targets.scene, clear: CLEAR }, (pass) => pass.draw(effects.scene));
  frame.pass({ target: targets.bloomA, clear: CLEAR }, (pass) => pass.draw(effects.brightPass));
  frame.pass({ target: targets.bloomB, clear: CLEAR }, (pass) => pass.draw(effects.blurH1));
  frame.pass({ target: targets.bloomA, clear: CLEAR }, (pass) => pass.draw(effects.blurV1));
  frame.pass({ target: targets.bloomB, clear: CLEAR }, (pass) => pass.draw(effects.blurH2));
  frame.pass({ target: targets.bloomA, clear: CLEAR }, (pass) => pass.draw(effects.blurV2));
  frame.pass({ target: output, clear: CLEAR }, (pass) => pass.draw(effects.composite));
}

function renderAt(gpu: Gpu, effects: Effects, targets: Targets, output: Target, time: number, pointer: Orbit): void {
  effects.scene.set({ params: { pointer, time } });
  gpu.frame((frame) => renderChain(frame, effects, targets, output));
}

function resizeTargets(targets: Targets, size: readonly [number, number]): void {
  const full = normalizeSize(size);
  targets.scene.resize(full);
  targets.bloomA.resize(bloomSize(full));
  targets.bloomB.resize(bloomSize(full));
}

function normalizeSize(size: readonly [number, number]): [number, number] {
  return [Math.max(1, Math.floor(size[0])), Math.max(1, Math.floor(size[1]))];
}

function bloomSize(size: readonly [number, number]): [number, number] {
  const height = Math.max(1, Math.min(BLOOM_HEIGHT, size[1]));
  return [Math.max(1, Math.round(height * size[0] / size[1])), height];
}

function installOrbitInput(canvas: HTMLCanvasElement) {
  let yaw = 0, pitch = 0.05, targetYaw = 0, targetPitch = 0.05;
  const previousTouchAction = canvas.style.touchAction;
  canvas.style.touchAction = 'none';
  const move = (event: PointerEvent) => {
    if (!event.isPrimary) return;
    const rect = canvas.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (event.clientX - rect.left) / Math.max(1, rect.width)));
    const y = Math.max(0, Math.min(1, (event.clientY - rect.top) / Math.max(1, rect.height)));
    targetYaw = (0.5 - x) * Math.PI * 1.4;
    targetPitch = Math.max(-Math.PI * 0.42, Math.min(Math.PI * 0.42, (y - 0.5) * Math.PI * 0.7));
  };
  canvas.addEventListener('pointermove', move);
  return {
    update(): Orbit {
      yaw += (targetYaw - yaw) * 0.12;
      pitch += (targetPitch - pitch) * 0.12;
      return [yaw, pitch];
    },
    dispose() {
      canvas.removeEventListener('pointermove', move);
      canvas.style.touchAction = previousTouchAction;
    },
  };
}
