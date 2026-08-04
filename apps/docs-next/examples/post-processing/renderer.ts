import type { Draw, Effect, Frame, Gpu, Surface, Target } from 'vgpu';
import type { BrowserRendererOptions, ExampleRenderer, RenderSize, ThumbnailOptions } from '../../lib/example-renderer';
import { DEFAULT_POST_PROCESSING_CONTROLS, type PostProcessingControls } from './types';
import blurWgsl from './blur.wgsl'; import gradeWgsl from './grade.wgsl'; import sceneWgsl from './scene.wgsl'; import thresholdWgsl from './threshold.wgsl';
import { clock, draw, effect, frame, frameLoop, sampler, surface, target } from "vgpu";
type PostProcessingMode = 'all-off' | 'bloom-only' | 'ca-only';
interface ThumbOptions extends ThumbnailOptions { onModeRendered?: (mode: PostProcessingMode, pixels: Uint8Array, size: readonly [number, number]) => void | Promise<void> }
interface EffectChain { scene: Draw; sceneVertexBuffer: GPUBuffer; threshold: Effect; blurH: Effect; blurV: Effect; grade: Effect; sampler: GPUSampler }
interface ChainTargets { scene: Target; bright: Target; blurA: Target; blurB: Target }
const FORMAT: GPUTextureFormat = 'rgba8unorm'; const SCENE_CLEAR: readonly [number, number, number, number] = [0.004, 0.006, 0.014, 1];
const THUMB_MODES: readonly [PostProcessingMode, PostProcessingControls][] = [['all-off', { bloom: false, ca: false }], ['bloom-only', { bloom: true, ca: false }], ['ca-only', { bloom: false, ca: true }]];

export function createRenderer(options: BrowserRendererOptions<PostProcessingControls>): ExampleRenderer<PostProcessingControls> {
 let disposed = false, reportedError = false; let controls = { ...(options.initialControls ?? DEFAULT_POST_PROCESSING_CONTROLS) };
 let gpu: Gpu | undefined, canvasSurface: Surface | undefined, effects: EffectChain | undefined, targets: ChainTargets | undefined, loop: { stop(): void } | undefined, observer: ResizeObserver | undefined;
 let resizeFrame = 0, pendingSize: RenderSize | undefined, lastDpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio;
 const applyResize = () => { resizeFrame = 0; const size = pendingSize; pendingSize = undefined; if (disposed || !size || !gpu || !canvasSurface || !effects || !targets) return; try { const nextTargets = createTargets(gpu, [Math.max(1, Math.round(size.width * size.dpr)), Math.max(1, Math.round(size.height * size.dpr))], 'post-processing-live'); destroyTargets(targets); targets = nextTargets; setChainBindings(effects, targets, canvasSurface); } catch (error) { fail(error); } };
 const resize = (size: RenderSize) => { if (disposed || size.width <= 0 || size.height <= 0) return; pendingSize = size; if (!resizeFrame) resizeFrame = requestAnimationFrame(applyResize); };
 const measure = () => { const rect = options.canvas.getBoundingClientRect(); resize({ width: rect.width, height: rect.height, dpr: Math.min(2, Math.max(1, window.devicePixelRatio || 1)) }); };
 const onWindowResize = () => { if (window.devicePixelRatio === lastDpr) return; lastDpr = window.devicePixelRatio; measure(); };
 const setControls = (next: Readonly<PostProcessingControls>) => { const valid = { bloom: Boolean(next.bloom), ca: Boolean(next.ca) }; if (disposed || (valid.bloom === controls.bloom && valid.ca === controls.ca)) return; controls = valid; if (effects) setGradeFlags(effects.grade, controls); };
 const dispose = () => { if (disposed) return; disposed = true; loop?.stop(); loop = undefined; if (resizeFrame) cancelAnimationFrame(resizeFrame); resizeFrame = 0; pendingSize = undefined; observer?.disconnect(); observer = undefined; if (typeof window !== 'undefined') window.removeEventListener('resize', onWindowResize); if (effects) destroyEffects(effects); effects = undefined; if (targets) destroyTargets(targets); targets = undefined; canvasSurface?.dispose(); canvasSurface = undefined; gpu?.dispose(); gpu = undefined; };
 const fail = (error: unknown) => { if (disposed) return; if (!reportedError) { reportedError = true; try { options.onError?.(error); } catch {} } dispose(); };
 const initialize = async () => { const { init } = await import('vgpu'); if (disposed) return; const nextGpu = await init(); if (disposed) { nextGpu.dispose(); return; } gpu = nextGpu; canvasSurface = surface(gpu, options.canvas, { dpr: [1, 2] }); effects = createEffects(gpu, 'post-processing-live'); targets = createTargets(gpu, canvasSurface.size, 'post-processing-live'); await prewarm(effects, targets, canvasSurface); if (disposed) return; setChainConstants(effects); setChainBindings(effects, targets, canvasSurface); setGradeFlags(effects.grade, controls); observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure); observer?.observe(options.canvas); window.addEventListener('resize', onWindowResize); measure(); const time = clock(gpu); loop = frameLoop(gpu, (currentFrame) => { if (!disposed && effects && targets && canvasSurface && gpu) renderChain(currentFrame, effects, targets, canvasSurface, time.time); }); };
 const ready = initialize().catch((error: unknown) => { if (disposed) return; fail(error); throw error; });
 return { ready, setControls, invalidate() {}, resize, dispose };
}

export async function renderThumbnail(gpu: Gpu, colorTarget: Target, opts: ThumbOptions = {}): Promise<void> {
 let effects: EffectChain | undefined; let targets: ChainTargets | undefined;
 try {
  effects = createEffects(gpu, 'post-processing-thumb'); targets = createTargets(gpu, colorTarget.size, 'post-processing-thumb'); await prewarm(effects, targets, colorTarget); setChainConstants(effects); setChainBindings(effects, targets, colorTarget); const dt = opts.dt ?? 1 / 60; let time = opts.time ?? 2;
  for (const [mode, flags] of THUMB_MODES) { setGradeFlags(effects.grade, flags); frame(gpu, (currentFrame) => renderChain(currentFrame, effects!, targets!, colorTarget, time)); await gpu.gpu.queue.onSubmittedWorkDone(); await opts.onModeRendered?.(mode, await colorTarget.read(), colorTarget.size); }
  setGradeFlags(effects.grade, DEFAULT_POST_PROCESSING_CONTROLS); for (let i = 0; i < Math.max(1, opts.warmupFrames ?? 60); i++) { time += dt; frame(gpu, (currentFrame) => renderChain(currentFrame, effects!, targets!, colorTarget, time)); }
 } finally {
  await Promise.allSettled([gpu.gpu.queue.onSubmittedWorkDone(), gpu.settled()]); if (targets) destroyTargets(targets); if (effects) destroyEffects(effects);
 }
}

function createEffects(gpu: Gpu, label: string): EffectChain {
  const vertices = createSceneVertices();
  const buffer = gpu.device.createBuffer({
    size: vertices.byteLength,
    usage: ['vertex', 'copy_dst'],
    label: `${label}-geometry`,
  });
  try {
    buffer.write(vertices.buffer as ArrayBuffer);
    return {
    scene: draw(gpu, {
      shader: sceneWgsl,
      label: `${label}-scene`,
      geometry: {
        vertexBuffers: [buffer.gpu],
        vertexBufferLayouts: [{
          arrayStride: 24,
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x2' },
            { shaderLocation: 1, offset: 8, format: 'float32x3' },
            { shaderLocation: 2, offset: 20, format: 'float32' },
          ],
        }],
        vertexCount: vertices.length / 6,
      },
    }),
    sceneVertexBuffer: buffer.gpu,
    threshold: effect(gpu, thresholdWgsl, { label: `${label}-threshold` }),
    // Separate effect instances avoid same-frame uniform/bind-group aliasing between directions.
    blurH: effect(gpu, blurWgsl, { label: `${label}-blur-h` }),
    blurV: effect(gpu, blurWgsl, { label: `${label}-blur-v` }),
    grade: effect(gpu, gradeWgsl, { label: `${label}-grade` }),
    sampler: sampler(gpu, { minFilter: 'linear', magFilter: 'linear' }),
  }; } catch (error) { buffer.gpu.destroy(); throw error; }
}

function createTargets(gpu: Gpu, size: readonly [number, number], label: string): ChainTargets {
  const full = normalizeSize(size);
  const half = halfSize(full);
  const created: Target[] = [];
  try {
    const scene = target(gpu, { size: full, format: FORMAT, label: `${label}-scene` }); created.push(scene);
    const bright = target(gpu, { size: half, format: FORMAT, label: `${label}-bright` }); created.push(bright);
    const blurA = target(gpu, { size: half, format: FORMAT, label: `${label}-blur-a` }); created.push(blurA);
    const blurB = target(gpu, { size: half, format: FORMAT, label: `${label}-blur-b` }); created.push(blurB);
    return { scene, bright, blurA, blurB };
  } catch (error) { for (const colorTarget of created) (colorTarget as Target & { destroy?: () => void }).destroy?.(); throw error; }
}

async function prewarm(effects: EffectChain, targets: ChainTargets, output: Surface | Target): Promise<void> {
  await Promise.all([
    effects.scene.compile(targets.scene),
    effects.threshold.compile(targets.bright),
    effects.blurH.compile(targets.blurA),
    effects.blurV.compile(targets.blurB),
    effects.grade.compile({ colors: [output.format] }),
  ]);
}

function setChainConstants(effects: EffectChain): void {
  effects.scene.set({ _pad: 0 });
  effects.threshold.set({ threshold: 0.82, knee: 0.045, linear_samp: effects.sampler });
  effects.blurH.set({ direction: [1, 0], linear_samp: effects.sampler });
  effects.blurV.set({ direction: [0, 1], linear_samp: effects.sampler });
  effects.grade.set({
    linear_samp: effects.sampler,
    bloomStrength: 1.85,
    caAmount: 0.052,
    _pad0: 0,
    _pad1: 0,
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

function setGradeFlags(grade: Effect, flags: PostProcessingControls): void {
  grade.set({
    bloomOn: flags.bloom ? 1 : 0,
    caOn: flags.ca ? 1 : 0,
  });
}

function renderChain(
  currentFrame: Frame,
  effects: EffectChain,
  targets: ChainTargets,
  output: Surface | Target,
  time: number,
): void {
  effects.scene.set({ time });
  currentFrame.pass({ target: targets.scene, clear: SCENE_CLEAR }, (pass) => pass.draw(effects.scene));
  // Extraction stays encoded while bloom is off so the final pass keeps stable bindings.
  currentFrame.pass({ target: targets.bright, clear: [0, 0, 0, 1] }, (pass) => pass.draw(effects.threshold));
  currentFrame.pass({ target: targets.blurA, clear: [0, 0, 0, 1] }, (pass) => pass.draw(effects.blurH));
  currentFrame.pass({ target: targets.blurB, clear: [0, 0, 0, 1] }, (pass) => pass.draw(effects.blurV));
  currentFrame.pass({ target: output, clear: [0, 0, 0, 1] }, (pass) => pass.draw(effects.grade));
}

function createSceneVertices(): Float32Array {
  const data: number[] = [];
  const addVertex = (point: readonly [number, number], color: readonly [number, number, number], phase: number) => {
    data.push(point[0], point[1], color[0], color[1], color[2], phase);
  };
  const addQuad = (points: readonly [readonly [number, number], readonly [number, number], readonly [number, number], readonly [number, number]], color: readonly [number, number, number], phase: number) => {
    for (const index of [0, 1, 2, 0, 2, 3]) addVertex(points[index], color, phase);
  };
  const corners = (cx: number, cy: number, width: number, height: number, angle: number) => {
    const c = Math.cos(angle), s = Math.sin(angle);
    return ([[-1, -1], [1, -1], [1, 1], [-1, 1]] as const).map(([x, y]) => {
      const px = x * width * 0.5, py = y * height * 0.5;
      return [cx + px * c - py * s, cy + px * s + py * c] as const;
    }) as unknown as readonly [readonly [number, number], readonly [number, number], readonly [number, number], readonly [number, number]];
  };
  const addRect = (cx: number, cy: number, width: number, height: number, angle: number, color: readonly [number, number, number], phase: number) => addQuad(corners(cx, cy, width, height, angle), color, phase);
  const addFrame = (cx: number, cy: number, width: number, height: number, thickness: number, angle: number, color: readonly [number, number, number], phase: number) => {
    addRect(cx, cy - height * 0.5, width, thickness, angle, color, phase);
    addRect(cx, cy + height * 0.5, width, thickness, angle, color, phase);
    addRect(cx - width * 0.5, cy, thickness, height, angle, color, phase);
    addRect(cx + width * 0.5, cy, thickness, height, angle, color, phase);
  };

  // Crisp architectural frames put hard edges near the lens periphery for chromatic aberration.
  addFrame(0, 0, 2.82, 1.42, 0.018, 0, [0.15, 0.48, 0.62], 0.10);
  addFrame(0, 0, 2.30, 1.05, 0.014, 0, [0.48, 0.16, 0.40], 0.24);
  addFrame(0, 0, 1.45, 0.70, 0.010, 0, [0.55, 0.47, 0.22], 0.38);
  addRect(-1.22, 0.20, 0.34, 0.23, -0.18, [0.48, 0.56, 0.62], 0.52);
  addRect(1.24, -0.20, 0.38, 0.25, 0.16, [0.54, 0.46, 0.58], 0.64);
  addRect(-0.72, -0.36, 0.42, 0.045, -0.32, [0.62, 0.32, 0.26], 0.74);
  addRect(0.72, 0.36, 0.42, 0.045, -0.32, [0.25, 0.52, 0.64], 0.82);
  addRect(0, 0, 0.018, 0.56, 0, [0.58, 0.58, 0.61], 0.90);
  addRect(0, 0, 0.56, 0.018, 0, [0.58, 0.58, 0.61], 0.90);

  // Small near-white cores are the only geometry above the extraction threshold.
  addRect(-1.25, -0.48, 0.070, 0.070, Math.PI / 4, [1.0, 0.96, 0.90], 0.14);
  addRect(1.27, 0.47, 0.064, 0.064, Math.PI / 4, [0.90, 1.0, 1.0], 0.31);
  addRect(-0.78, 0.33, 0.055, 0.055, Math.PI / 4, [1.0, 0.91, 0.98], 0.48);
  addRect(0.83, -0.35, 0.058, 0.058, Math.PI / 4, [0.96, 1.0, 0.86], 0.67);
  addRect(0.03, 0.02, 0.046, 0.046, Math.PI / 4, [1.0, 1.0, 1.0], 0.87);
  return new Float32Array(data);
}

function normalizeSize(size: readonly [number, number]): readonly [number, number] {
  return [Math.max(1, Math.floor(size[0])), Math.max(1, Math.floor(size[1]))];
}

function halfSize(size: readonly [number, number]): readonly [number, number] {
  return [Math.max(1, Math.ceil(size[0] / 2)), Math.max(1, Math.ceil(size[1] / 2))];
}

function destroyEffects(effects: EffectChain): void {
  effects.sceneVertexBuffer.destroy();
}

function destroyTargets(targets: ChainTargets): void {
  for (const colorTarget of [targets.scene, targets.bright, targets.blurA, targets.blurB]) {
    (colorTarget as Target & { destroy?: () => void }).destroy?.();
  }
}
