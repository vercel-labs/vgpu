import type { Effect, Frame, Gpu, Surface, Target } from 'vgpu';

import blackHoleWgsl from './black-hole.wgsl';
import blurWgsl from './blur.wgsl';
import brightPassWgsl from './bright-pass.wgsl';
import compositeWgsl from './composite.wgsl';

import type { BrowserRendererOptions, ExampleRenderer, RenderSize, ThumbnailOptions } from '../../lib/example-renderer';
import { clock, effect, frame, frameLoop, sampler, surface, target } from "vgpu";

type Output = Surface | Target;
type Orbit = readonly [number, number];

interface ThumbOptions extends ThumbnailOptions {
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

export function createRenderer(options: BrowserRendererOptions): ExampleRenderer {
  let disposed = false;
  let gpu: Gpu | undefined;
  let canvasSurface: Surface | undefined;
  let effects: Effects | undefined;
  let targets: Targets | undefined;
  let input: ReturnType<typeof installOrbitInput> | undefined;
  let loop: { stop(): void } | undefined;
  let observer: ResizeObserver | undefined;
  let resizeFrame = 0;
  let pendingSize: RenderSize | undefined;
  let lastDpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio;
  let reportedError = false;

  const applyResize = () => {
    resizeFrame = 0;
    const size = pendingSize;
    pendingSize = undefined;
    if (disposed || !size || !gpu || !effects || !targets || !canvasSurface) return;
    try {
      const previousTargets = targets;
      const nextTargets = createTargets(gpu, [
        Math.max(1, Math.round(size.width * size.dpr)),
        Math.max(1, Math.round(size.height * size.dpr)),
      ], 'black-hole-live');
      try {
        setBindings(effects, nextTargets, canvasSurface);
      } catch (error) {
        destroyTargets(nextTargets);
        throw error;
      }
      targets = nextTargets;
      destroyTargets(previousTargets);
    } catch (error) {
      handleFailure(error);
    }
  };
  const resize = (size: RenderSize) => {
    if (disposed || size.width <= 0 || size.height <= 0) return;
    pendingSize = size;
    if (!resizeFrame) resizeFrame = requestAnimationFrame(applyResize);
  };
  const measure = () => {
    const rect = options.canvas.getBoundingClientRect();
    resize({ width: rect.width, height: rect.height, dpr: Math.min(1.6, Math.max(1, window.devicePixelRatio || 1)) });
  };
  const onWindowResize = () => {
    if (window.devicePixelRatio === lastDpr) return;
    lastDpr = window.devicePixelRatio;
    measure();
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    loop?.stop();
    loop = undefined;
    if (resizeFrame) cancelAnimationFrame(resizeFrame);
    resizeFrame = 0;
    pendingSize = undefined;
    observer?.disconnect();
    observer = undefined;
    if (typeof window !== 'undefined') window.removeEventListener('resize', onWindowResize);
    input?.dispose();
    input = undefined;
    if (targets) destroyTargets(targets);
    targets = undefined;
    canvasSurface?.dispose();
    canvasSurface = undefined;
    gpu?.dispose();
    gpu = undefined;
    effects = undefined;
  };

  const initialize = async () => {
    const { init } = await import('vgpu');
    if (disposed) return;
    const nextGpu = await init();
    if (disposed) { nextGpu.dispose(); return; }
    gpu = nextGpu;
    canvasSurface = surface(gpu, options.canvas, { dpr: [1, 1.6] });
    effects = createEffects(gpu, 'black-hole-live');
    targets = createTargets(gpu, canvasSurface.size, 'black-hole-live');
    setConstants(effects);
    setBindings(effects, targets, canvasSurface);
    await prewarm(effects, targets, canvasSurface);
    if (disposed) return;
    input = installOrbitInput(options.canvas);
    observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure);
    observer?.observe(options.canvas);
    window.addEventListener('resize', onWindowResize);
    measure();
    const gpuClock = clock(gpu);
    loop = frameLoop(gpu, (currentFrame) => {
      if (disposed || !effects || !targets || !canvasSurface || !input) return;
      effects.scene.set({ params: { pointer: input.update(), time: gpuClock.time } });
      renderChain(currentFrame, effects, targets, canvasSurface);
    });
  };

  function handleFailure(error: unknown): void {
    if (disposed) return;
    if (!reportedError) {
      reportedError = true;
      try { options.onError?.(error); } catch { /* error reporting must not block teardown */ }
    }
    dispose();
  }

  const ready = initialize().catch((error: unknown) => {
    if (disposed) return;
    handleFailure(error);
    throw error;
  });

  return { ready, invalidate() {}, resize, dispose };
}

export async function renderThumbnail(gpu: Gpu, colorTarget: Target, opts: ThumbOptions = {}): Promise<void> {
  const effects = createEffects(gpu, 'black-hole-thumb');
  const targets = createTargets(gpu, colorTarget.size, 'black-hole-thumb');
  try {
    const time = opts.time ?? 8.5;
    setConstants(effects);
    setBindings(effects, targets, colorTarget);
    await prewarm(effects, targets, colorTarget);

    renderAt(gpu, effects, targets, colorTarget, time, [0, 0.05]);
    await gpu.gpu.queue.onSubmittedWorkDone();

    renderAt(gpu, effects, targets, colorTarget, time + 7, [0, 0.05]);
    await gpu.gpu.queue.onSubmittedWorkDone();
    await opts.onVariantRendered?.('time-delta', await colorTarget.read(), colorTarget.size);

    renderAt(gpu, effects, targets, colorTarget, time, [0.72, 0.34]);
    await gpu.gpu.queue.onSubmittedWorkDone();
    await opts.onVariantRendered?.('pointer-orbit', await colorTarget.read(), colorTarget.size);

    // Leave the deterministic poster framing in the output target.
    renderAt(gpu, effects, targets, colorTarget, time, [0, 0.05]);
  } finally {
    await Promise.allSettled([
      Promise.resolve().then(() => gpu.gpu.queue.onSubmittedWorkDone()),
      Promise.resolve().then(() => gpu.settled()),
    ]);
    destroyTargets(targets);
  }
}

function createEffects(gpu: Gpu, label: string): Effects {
  return {
    scene: effect(gpu, blackHoleWgsl, { label: `${label}-scene` }),
    brightPass: effect(gpu, brightPassWgsl, { label: `${label}-bright-pass` }),
    // Each pass owns its uniform buffer; mutating one effect repeatedly in a frame
    // would make all encoded passes observe the final direction and radius.
    blurH1: effect(gpu, blurWgsl, { label: `${label}-blur-h1` }),
    blurV1: effect(gpu, blurWgsl, { label: `${label}-blur-v1` }),
    blurH2: effect(gpu, blurWgsl, { label: `${label}-blur-h2` }),
    blurV2: effect(gpu, blurWgsl, { label: `${label}-blur-v2` }),
    composite: effect(gpu, compositeWgsl, { label: `${label}-composite` }),
    sampler: sampler(gpu, { minFilter: 'linear', magFilter: 'linear' }),
  };
}

function createTargets(gpu: Gpu, size: readonly [number, number], label: string): Targets {
  const full = normalizeSize(size);
  const bloom = bloomSize(full);
  let scene: Target | undefined;
  let bloomA: Target | undefined;
  try {
    scene = target(gpu, { size: full, format: HDR_FORMAT, label: `${label}-scene` });
    bloomA = target(gpu, { size: bloom, format: HDR_FORMAT, label: `${label}-bloom-a` });
    const bloomB = target(gpu, { size: bloom, format: HDR_FORMAT, label: `${label}-bloom-b` });
    return { scene, bloomA, bloomB };
  } catch (error) {
    destroyTarget(bloomA);
    destroyTarget(scene);
    throw error;
  }
}

function destroyTargets(targets: Targets): void {
  destroyTarget(targets.bloomB);
  destroyTarget(targets.bloomA);
  destroyTarget(targets.scene);
}

function destroyTarget(colorTarget: Target | undefined): void {
  (colorTarget as { destroy?: () => void } | undefined)?.destroy?.();
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
    effects.composite.compile({ colors: [output.format] }),
  ]);
}

function renderChain(currentFrame: Frame, effects: Effects, targets: Targets, output: Output): void {
  currentFrame.pass({ target: targets.scene, clear: CLEAR }, (pass) => pass.draw(effects.scene));
  currentFrame.pass({ target: targets.bloomA, clear: CLEAR }, (pass) => pass.draw(effects.brightPass));
  currentFrame.pass({ target: targets.bloomB, clear: CLEAR }, (pass) => pass.draw(effects.blurH1));
  currentFrame.pass({ target: targets.bloomA, clear: CLEAR }, (pass) => pass.draw(effects.blurV1));
  currentFrame.pass({ target: targets.bloomB, clear: CLEAR }, (pass) => pass.draw(effects.blurH2));
  currentFrame.pass({ target: targets.bloomA, clear: CLEAR }, (pass) => pass.draw(effects.blurV2));
  currentFrame.pass({ target: output, clear: CLEAR }, (pass) => pass.draw(effects.composite));
}

function renderAt(gpu: Gpu, effects: Effects, targets: Targets, output: Target, time: number, pointer: Orbit): void {
  effects.scene.set({ params: { pointer, time } });
  frame(gpu, (currentFrame) => renderChain(currentFrame, effects, targets, output));
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
  let activePointer: number | undefined;
  const previousTouchAction = canvas.style.touchAction;
  canvas.style.touchAction = 'none';

  const down = (event: PointerEvent) => {
    if (!event.isPrimary || activePointer !== undefined) return;
    activePointer = event.pointerId;
    canvas.setPointerCapture?.(event.pointerId);
  };
  const move = (event: PointerEvent) => {
    if (!event.isPrimary || (activePointer !== undefined && event.pointerId !== activePointer)) return;
    const rect = canvas.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (event.clientX - rect.left) / Math.max(1, rect.width)));
    const y = Math.max(0, Math.min(1, (event.clientY - rect.top) / Math.max(1, rect.height)));
    targetYaw = (0.5 - x) * Math.PI * 1.4;
    targetPitch = Math.max(-Math.PI * 0.42, Math.min(Math.PI * 0.42, (y - 0.5) * Math.PI * 0.7));
  };
  const end = (event: PointerEvent) => {
    if (event.pointerId !== activePointer) return;
    if (canvas.hasPointerCapture?.(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    activePointer = undefined;
  };
  canvas.addEventListener('pointerdown', down);
  canvas.addEventListener('pointermove', move);
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  return {
    update(): Orbit {
      yaw += (targetYaw - yaw) * 0.12;
      pitch += (targetPitch - pitch) * 0.12;
      return [yaw, pitch];
    },
    dispose() {
      canvas.removeEventListener('pointerdown', down);
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerup', end);
      canvas.removeEventListener('pointercancel', end);
      if (activePointer !== undefined && canvas.hasPointerCapture?.(activePointer)) canvas.releasePointerCapture(activePointer);
      activePointer = undefined;
      canvas.style.touchAction = previousTouchAction;
    },
  };
}
