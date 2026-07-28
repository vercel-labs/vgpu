import type { Draw, Effect, Frame, Gpu, Surface, Target } from 'vgpu';
import type { BrowserRendererOptions, ExampleRenderer, RenderSize, ThumbnailOptions } from '../../lib/example-renderer';
import { AA_MODE_FXAA, AA_MODE_MSAA_4X, AA_MODE_OFF, AA_MODE_SSAA_2X, DEFAULT_ANTI_ALIASING_CONTROLS, type AaMode, type AntiAliasingControls } from './types';
import sceneWgsl from './scene.wgsl';
import resolveWgsl from './resolve.wgsl';
import fxaaWgsl from './fxaa.wgsl';

interface ThumbOptions extends ThumbnailOptions { onModeRendered?: (mode: AaMode, pixels: Uint8Array, size: readonly [number, number]) => void | Promise<void> }
interface AaEffects { readonly scene: Draw; readonly vertexBuffer: GPUBuffer; readonly resolve: Effect; readonly fxaa: Effect; readonly sampler: GPUSampler }
interface AaTargets { readonly msaa: Target; readonly ssaa: Target; readonly ldr: Target }
const FORMAT: GPUTextureFormat = 'rgba8unorm';
const CLEAR_BLACK: readonly [number, number, number, number] = [0, 0, 0, 1];
const ALL_MODES: readonly AaMode[] = [AA_MODE_OFF, AA_MODE_MSAA_4X, AA_MODE_SSAA_2X, AA_MODE_FXAA];
const isMode = (value: number): value is AaMode => ALL_MODES.includes(value as AaMode);

export function createRenderer(options: BrowserRendererOptions<AntiAliasingControls>): ExampleRenderer<AntiAliasingControls> {
  let disposed = false, reportedError = false;
  let controls = { ...(options.initialControls ?? DEFAULT_ANTI_ALIASING_CONTROLS) };
  if (!isMode(controls.mode)) controls = { ...DEFAULT_ANTI_ALIASING_CONTROLS };
  let gpu: Gpu | undefined, surface: Surface | undefined, effects: AaEffects | undefined, targets: AaTargets | undefined;
  let loop: { stop(): void } | undefined, observer: ResizeObserver | undefined, resizeFrame = 0, pendingSize: RenderSize | undefined;
  let lastDpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio;
  const applyResize = () => { resizeFrame = 0; const size = pendingSize; pendingSize = undefined; if (disposed || !size || !targets || !effects || !surface) return; try { resizeTargets(targets, [Math.max(1, Math.round(size.width * size.dpr)), Math.max(1, Math.round(size.height * size.dpr))]); setResolutionBindings(effects, surface); } catch (error) { fail(error); } };
  const resize = (size: RenderSize) => { if (disposed || size.width <= 0 || size.height <= 0) return; pendingSize = size; if (!resizeFrame) resizeFrame = requestAnimationFrame(applyResize); };
  const measure = () => { const rect = options.canvas.getBoundingClientRect(); resize({ width: rect.width, height: rect.height, dpr: Math.min(2, Math.max(1, window.devicePixelRatio || 1)) }); };
  const onWindowResize = () => { if (window.devicePixelRatio === lastDpr) return; lastDpr = window.devicePixelRatio; measure(); };
  const setControls = (next: Readonly<AntiAliasingControls>) => { if (disposed || !isMode(next.mode) || next.mode === controls.mode) return; controls = { mode: next.mode }; if (effects && targets) setModeBindings(effects, targets, controls.mode); };
  const dispose = () => { if (disposed) return; disposed = true; loop?.stop(); loop = undefined; if (resizeFrame) cancelAnimationFrame(resizeFrame); resizeFrame = 0; pendingSize = undefined; observer?.disconnect(); observer = undefined; if (typeof window !== 'undefined') window.removeEventListener('resize', onWindowResize); if (effects) destroyEffects(effects); effects = undefined; if (targets) destroyTargets(targets); targets = undefined; surface?.dispose(); surface = undefined; gpu?.dispose(); gpu = undefined; };
  const fail = (error: unknown) => { if (disposed) return; if (!reportedError) { reportedError = true; try { options.onError?.(error); } catch {} } dispose(); };
  const initialize = async () => { const { init } = await import('vgpu'); if (disposed) return; const nextGpu = await init(); if (disposed) { nextGpu.dispose(); return; } gpu = nextGpu; surface = gpu.surface(options.canvas, { dpr: [1, 2] }); effects = createEffects(gpu, 'anti-aliasing'); targets = createTargets(gpu, surface.size, 'anti-aliasing'); await prewarm(effects, targets, surface); if (disposed) return; setStaticBindings(effects, targets); setResolutionBindings(effects, surface); setModeBindings(effects, targets, controls.mode); observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure); observer?.observe(options.canvas); window.addEventListener('resize', onWindowResize); measure(); loop = gpu.frame.loop((frame) => { if (!disposed && effects && targets && surface && gpu) renderMode(frame, effects, targets, surface, controls.mode, gpu.time); }); };
  const ready = initialize().catch((error: unknown) => { if (disposed) return; fail(error); throw error; });
  return { ready, setControls, invalidate() {}, resize, dispose };
}

export async function renderThumbnail(gpu: Gpu, target: Target, opts: ThumbOptions = {}): Promise<void> {
  let effects: AaEffects | undefined; let targets: AaTargets | undefined;
  try {
    effects = createEffects(gpu, 'anti-aliasing-thumb'); targets = createTargets(gpu, target.size, 'anti-aliasing-thumb'); await prewarm(effects, targets, target); setStaticBindings(effects, targets); setResolutionBindings(effects, target); let configuredMode: AaMode | undefined;
    const configureMode = (mode: AaMode) => { if (mode !== configuredMode) { configuredMode = mode; setModeBindings(effects!, targets!, mode); } };
    const dt = opts.dt ?? 1 / 60; let time = opts.time ?? 1.2;
    for (const mode of ALL_MODES) { configureMode(mode); gpu.frame((frame) => renderMode(frame, effects!, targets!, target, mode, time)); await gpu.gpu.queue.onSubmittedWorkDone(); await opts.onModeRendered?.(mode, await target.read(), target.size); }
    for (let i = 0; i < Math.max(1, opts.warmupFrames ?? 60); i++) { time += dt; configureMode(DEFAULT_ANTI_ALIASING_CONTROLS.mode); gpu.frame((frame) => renderMode(frame, effects!, targets!, target, DEFAULT_ANTI_ALIASING_CONTROLS.mode, time)); }
  } finally {
    await Promise.allSettled([gpu.gpu.queue.onSubmittedWorkDone(), gpu.settled()]); if (targets) destroyTargets(targets); if (effects) destroyEffects(effects);
  }
}

function createEffects(gpu: Gpu, label: string): AaEffects {
  const vertices = createSpokeVertices();
  const buffer = gpu.device.createBuffer({
    size: vertices.byteLength,
    usage: ['vertex', 'copy_dst'],
    label: `${label}-geometry`,
  });
  try {
    buffer.write(vertices.buffer as ArrayBuffer);
    return {
    scene: gpu.draw({
      shader: sceneWgsl,
      label: `${label}-scene`,
      geometry: {
        vertexBuffers: [buffer.gpu],
        vertexBufferLayouts: [{
          arrayStride: 12,
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x2' },
            { shaderLocation: 1, offset: 8, format: 'float32' },
          ],
        }],
        vertexCount: vertices.length / 3,
      },
    }),
    vertexBuffer: buffer.gpu,
    resolve: gpu.effect(resolveWgsl, { label: `${label}-resolve` }),
    fxaa: gpu.effect(fxaaWgsl, { label: `${label}-fxaa` }),
    sampler: gpu.sampler({
      minFilter: 'linear',
      magFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    }),
  }; } catch (error) { buffer.gpu.destroy(); throw error; }
}

function createTargets(gpu: Gpu, size: readonly [number, number], label: string): AaTargets {
  const [width, height] = normalizedSize(size);
  const created: Target[] = [];
  try {
    // Dawn compat in Docker rejects rgba16float+MSAA, so every AA intermediate is rgba8unorm.
    const msaa = gpu.target({ size: [width, height], format: FORMAT, msaa: true, label: `${label}-msaa-4x` }); created.push(msaa);
    const ssaa = gpu.target({ size: [width * 2, height * 2], format: FORMAT, label: `${label}-ssaa-2x` }); created.push(ssaa);
    const ldr = gpu.target({ size: [width, height], format: FORMAT, label: `${label}-fxaa-ldr` }); created.push(ldr);
    return { msaa, ssaa, ldr };
  } catch (error) { for (const target of created) (target as Target & { destroy?: () => void }).destroy?.(); throw error; }
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
    effects.scene.compile({ colors: [output.format] }),
    effects.scene.compile(targets.msaa),
    effects.scene.compile(targets.ssaa),
    effects.scene.compile(targets.ldr),
    effects.resolve.compile({ colors: [output.format] }),
    effects.fxaa.compile({ colors: [output.format] }),
  ]);
}

function setStaticBindings(effects: AaEffects, targets: AaTargets): void {
  effects.fxaa.set({
    uniforms: {
      edge_threshold: 0.166,
      edge_threshold_min: 0.0833,
      subpix: 0.75,
      _pad0: 0,
      _pad1: 0,
      _pad2: 0,
    },
    scene_tex: targets.ldr,
    linear_samp: effects.sampler,
  });
}

function setResolutionBindings(effects: AaEffects, output: Surface | Target): void {
  effects.scene.set({ logical_resolution: output.size, _pad: 0 });
  effects.resolve.set({ resolution: output.size, _pad: 0 });
  effects.fxaa.set({ resolution: output.size });
}

function setModeBindings(effects: AaEffects, targets: AaTargets, mode: AaMode): void {
  if (mode === AA_MODE_MSAA_4X) {
    effects.resolve.set({ kind: 0, scene_tex: targets.msaa });
  } else if (mode === AA_MODE_SSAA_2X) {
    effects.resolve.set({ kind: 1, scene_tex: targets.ssaa });
  }
}

function renderMode(
  frame: Frame,
  effects: AaEffects,
  targets: AaTargets,
  output: Surface | Target,
  mode: AaMode,
  time: number,
): void {
  effects.scene.set({ time });

  if (mode === AA_MODE_OFF) {
    frame.pass({ target: output, clear: CLEAR_BLACK }, (pass) => pass.draw(effects.scene));
    return;
  }

  if (mode === AA_MODE_MSAA_4X) {
    frame.pass({ target: targets.msaa, clear: CLEAR_BLACK }, (pass) => pass.draw(effects.scene));
    frame.pass({ target: output, clear: CLEAR_BLACK }, (pass) => pass.draw(effects.resolve));
    return;
  }

  if (mode === AA_MODE_SSAA_2X) {
    frame.pass({ target: targets.ssaa, clear: CLEAR_BLACK }, (pass) => pass.draw(effects.scene));
    frame.pass({ target: output, clear: CLEAR_BLACK }, (pass) => pass.draw(effects.resolve));
    return;
  }

  frame.pass({ target: targets.ldr, clear: CLEAR_BLACK }, (pass) => pass.draw(effects.scene));
  frame.pass({ target: output, clear: CLEAR_BLACK }, (pass) => pass.draw(effects.fxaa));
}

function createSpokeVertices(): Float32Array {
  const data: number[] = [];
  const spokeCount = 44;
  for (let i = 0; i < spokeCount; i++) {
    const angle = (i / spokeCount) * Math.PI * 2;
    const direction: readonly [number, number] = [Math.cos(angle), Math.sin(angle)];
    const normal: readonly [number, number] = [-direction[1], direction[0]];
    const inner = i % 4 === 0 ? 0.06 : 0.13;
    const outer = i % 5 === 0 ? 0.88 : 0.72 + (i % 3) * 0.055;
    const halfWidth = i % 5 === 0 ? 0.009 : 0.0045;
    const accent = (i % 7) / 6;
    const a: readonly [number, number] = [direction[0] * inner + normal[0] * halfWidth, direction[1] * inner + normal[1] * halfWidth];
    const b: readonly [number, number] = [direction[0] * inner - normal[0] * halfWidth, direction[1] * inner - normal[1] * halfWidth];
    const c: readonly [number, number] = [direction[0] * outer - normal[0] * halfWidth, direction[1] * outer - normal[1] * halfWidth];
    const d: readonly [number, number] = [direction[0] * outer + normal[0] * halfWidth, direction[1] * outer + normal[1] * halfWidth];
    for (const point of [a, b, c, a, c, d]) data.push(point[0], point[1], accent);
  }
  return new Float32Array(data);
}

function normalizedSize(size: readonly [number, number]): [number, number] {
  return [Math.max(1, Math.floor(size[0])), Math.max(1, Math.floor(size[1]))];
}

function destroyEffects(effects: AaEffects): void {
  effects.vertexBuffer.destroy();
}

function destroyTargets(targets: AaTargets): void {
  for (const target of [targets.msaa, targets.ssaa, targets.ldr]) {
    (target as Target & { destroy?: () => void }).destroy?.();
  }
}
