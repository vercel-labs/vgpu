import type { Effect, Frame, Gpu, Surface, Target } from 'vgpu';

import { createRenderScheduler, installDragOrbit, type Orbit } from './pointer-input';
import type { BrowserRendererOptions, ExampleRenderer, RenderSize, ThumbnailOptions } from '../../lib/example-renderer';
import fractalWgsl from './fractal.wgsl';
import brightPassWgsl from './bright-pass.wgsl';
import blurWgsl from './blur.wgsl';
import compositeWgsl from './composite.wgsl';
import { effect, frame, sampler, surface, target } from "vgpu";

type Output = Surface | Target;
type Variant = 'static-repeat' | 'alternate-orbit' | 'bloom-off';
interface ThumbOptions extends ThumbnailOptions {
  onVariantRendered?: (variant: Variant, pixels: Uint8Array, size: readonly [number, number]) => void | Promise<void>;
}
interface Effects {
  scene: Effect; brightPass: Effect; blurH: Effect; blurV: Effect; composite: Effect; sampler: GPUSampler;
}
interface Targets { scene: Target; bloomA: Target; bloomB: Target }

const HDR_FORMAT: GPUTextureFormat = 'rgba16float';
const BLOOM_HEIGHT = 360;
const CLEAR: readonly [number, number, number, number] = [0, 0, 0, 1];
const POSTER: Readonly<Orbit> = { yaw: 0.58, pitch: 0.24 };
const ALTERNATE: Readonly<Orbit> = { yaw: -0.35, pitch: 0.10 };

export function createRenderer(options: BrowserRendererOptions): ExampleRenderer {
  let disposed = false;
  let reportedError = false;
  let gpu: Gpu | undefined;
  let canvasSurface: Surface | undefined;
  let effects: Effects | undefined;
  let targets: Targets | undefined;
  let scheduler: ReturnType<typeof createRenderScheduler> | undefined;
  let disposeInput: (() => void) | undefined;
  let observer: ResizeObserver | undefined;
  let resizeFrame = 0;
  let pendingSize: RenderSize | undefined;
  let lastDpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio;
  const orbit: Orbit = { ...POSTER };

  const renderOnce = () => {
    if (disposed || !gpu || !canvasSurface || !effects || !targets) return;
    effects.scene.set({ params: orbit });
    frame(gpu, (currentFrame) => renderChain(currentFrame, effects!, targets!, canvasSurface!));
  };
  const applyResize = () => {
    resizeFrame = 0;
    const size = pendingSize;
    pendingSize = undefined;
    if (disposed || !size || !targets || !effects) return;
    resizeTargets(targets, [
      Math.max(1, Math.round(size.width * size.dpr)),
      Math.max(1, Math.round(size.height * size.dpr)),
    ]);
    setBindings(effects, targets);
    scheduler?.request();
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

  function dispose() {
    if (disposed) return;
    disposed = true;
    scheduler?.dispose();
    scheduler = undefined;
    if (resizeFrame) cancelAnimationFrame(resizeFrame);
    resizeFrame = 0;
    pendingSize = undefined;
    observer?.disconnect();
    observer = undefined;
    if (typeof window !== 'undefined') window.removeEventListener('resize', onWindowResize);
    disposeInput?.();
    disposeInput = undefined;
    if (targets) destroyTargets(targets);
    targets = undefined;
    effects = undefined;
    canvasSurface?.dispose();
    canvasSurface = undefined;
    gpu?.dispose();
    gpu = undefined;
  }

  const initialize = async () => {
    const { init } = await import('vgpu');
    if (disposed) return;
    const nextGpu = await init();
    if (disposed) { nextGpu.dispose(); return; }
    gpu = nextGpu;
    canvasSurface = surface(gpu, options.canvas, { dpr: [1, 1.6] });
    effects = createEffects(gpu, 'raymarched-fractal-live');
    targets = createTargets(gpu, canvasSurface.size, 'raymarched-fractal-live');
    setConstants(effects);
    setBindings(effects, targets);
    await prewarm(effects, targets, canvasSurface);
    if (disposed) return;
    scheduler = createRenderScheduler(renderOnce);
    disposeInput = installDragOrbit(options.canvas, orbit, scheduler.request);
    observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure);
    observer?.observe(options.canvas);
    window.addEventListener('resize', onWindowResize);
    measure();
    scheduler.request();
  };

  const ready = initialize().catch((error: unknown) => {
    if (disposed) return;
    if (!reportedError) { reportedError = true; options.onError?.(error); }
    dispose();
    throw error;
  });

  return { ready, invalidate: () => scheduler?.request(), resize, dispose };
}

export async function renderThumbnail(gpu: Gpu, colorTarget: Target, opts: ThumbOptions = {}): Promise<void> {
  const effects = createEffects(gpu, 'raymarched-fractal-thumb');
  const targets = createTargets(gpu, colorTarget.size, 'raymarched-fractal-thumb');
  setConstants(effects);
  setBindings(effects, targets);
  try {
    await prewarm(effects, targets, colorTarget);
    await renderAndWait(gpu, effects, targets, colorTarget, POSTER);
    await renderAndWait(gpu, effects, targets, colorTarget, POSTER);
    await reportVariant(opts, 'static-repeat', colorTarget);
    await renderAndWait(gpu, effects, targets, colorTarget, ALTERNATE);
    await reportVariant(opts, 'alternate-orbit', colorTarget);
    effects.composite.set({ composite: { bloomStrength: 0 } });
    await renderAndWait(gpu, effects, targets, colorTarget, POSTER);
    await reportVariant(opts, 'bloom-off', colorTarget);
    effects.composite.set({ composite: { bloomStrength: 0.65 } });
    await renderAndWait(gpu, effects, targets, colorTarget, POSTER);
    await gpu.settled();
  } finally {
    try {
      await gpu.gpu.queue.onSubmittedWorkDone();
    } finally {
      destroyTargets(targets);
    }
  }
}

async function reportVariant(opts: ThumbOptions, variant: Variant, colorTarget: Target): Promise<void> {
  if (!opts.onVariantRendered) return;
  const pixels = await colorTarget.read();
  await opts.onVariantRendered(variant, new Uint8Array(pixels), colorTarget.size);
}
async function renderAndWait(gpu: Gpu, effects: Effects, targets: Targets, output: Target, orbit: Readonly<Orbit>) {
  effects.scene.set({ params: orbit });
  frame(gpu, (currentFrame) => renderChain(currentFrame, effects, targets, output));
  await gpu.gpu.queue.onSubmittedWorkDone();
}

function createEffects(gpu: Gpu, label: string): Effects {
  return {
    scene: effect(gpu, fractalWgsl, { label: `${label}-scene` }),
    brightPass: effect(gpu, brightPassWgsl, { label: `${label}-bright-pass` }),
    blurH: effect(gpu, blurWgsl, { label: `${label}-blur-h` }),
    blurV: effect(gpu, blurWgsl, { label: `${label}-blur-v` }),
    composite: effect(gpu, compositeWgsl, { label: `${label}-composite` }),
    sampler: sampler(gpu, { minFilter: 'linear', magFilter: 'linear' }),
  };
}
function createTargets(gpu: Gpu, size: readonly [number, number], label: string): Targets {
  const full = normalizeSize(size), bloom = bloomSize(full);
  let scene: Target | undefined;
  let bloomA: Target | undefined;
  let bloomB: Target | undefined;
  try {
    scene = target(gpu, { size: full, format: HDR_FORMAT, label: `${label}-scene` });
    bloomA = target(gpu, { size: bloom, format: HDR_FORMAT, label: `${label}-bloom-a` });
    bloomB = target(gpu, { size: bloom, format: HDR_FORMAT, label: `${label}-bloom-b` });
    return { scene, bloomA, bloomB };
  } catch (error) {
    scene?.color.destroy();
    bloomA?.color.destroy();
    bloomB?.color.destroy();
    throw error;
  }
}
function setConstants(e: Effects): void {
  e.scene.set({ params: { resolution: [1, 1], ...POSTER } });
  e.brightPass.set({ samp: e.sampler, bright: { threshold: 1, knee: 0.25 } });
  e.blurH.set({ samp: e.sampler, blur: { direction: [1, 0], radius: 1.6 } });
  e.blurV.set({ samp: e.sampler, blur: { direction: [0, 1], radius: 1.6 } });
  e.composite.set({ samp: e.sampler, composite: { exposure: 1.05, bloomStrength: 0.65 } });
}
function setBindings(e: Effects, t: Targets): void {
  e.scene.set({ params: { resolution: t.scene.size } });
  e.brightPass.set({ src: t.scene });
  e.blurH.set({ src: t.bloomA, blur: { texelSize: t.bloomA.texelSize } });
  e.blurV.set({ src: t.bloomB, blur: { texelSize: t.bloomB.texelSize } });
  e.composite.set({ scene: t.scene, bloom: t.bloomA });
}
async function prewarm(e: Effects, t: Targets, output: Output): Promise<void> {
  await Promise.all([
    e.scene.compile(t.scene), e.brightPass.compile(t.bloomA), e.blurH.compile(t.bloomB),
    e.blurV.compile(t.bloomA), e.composite.compile({ colors: [output.format] }),
  ]);
}
function renderChain(currentFrame: Frame, e: Effects, t: Targets, output: Output): void {
  currentFrame.pass({ target: t.scene, clear: CLEAR }, (pass) => pass.draw(e.scene));
  currentFrame.pass({ target: t.bloomA, clear: CLEAR }, (pass) => pass.draw(e.brightPass));
  currentFrame.pass({ target: t.bloomB, clear: CLEAR }, (pass) => pass.draw(e.blurH));
  currentFrame.pass({ target: t.bloomA, clear: CLEAR }, (pass) => pass.draw(e.blurV));
  currentFrame.pass({ target: output, clear: CLEAR }, (pass) => pass.draw(e.composite));
}
function resizeTargets(t: Targets, size: readonly [number, number]): void {
  const full = normalizeSize(size), bloom = bloomSize(full);
  t.scene.resize(full); t.bloomA.resize(bloom); t.bloomB.resize(bloom);
}
function normalizeSize(size: readonly [number, number]): [number, number] {
  return [Math.max(1, Math.floor(size[0])), Math.max(1, Math.floor(size[1]))];
}
function bloomSize(size: readonly [number, number]): [number, number] {
  const height = Math.max(1, Math.min(BLOOM_HEIGHT, size[1]));
  return [Math.max(1, Math.round(height * size[0] / size[1])), height];
}
function destroyTargets(t: Targets): void { t.scene.color.destroy(); t.bloomA.color.destroy(); t.bloomB.color.destroy(); }
