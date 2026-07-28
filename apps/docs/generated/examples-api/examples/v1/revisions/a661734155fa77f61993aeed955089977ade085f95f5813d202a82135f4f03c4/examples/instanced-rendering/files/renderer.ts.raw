import type { Bundle, Draw, Effect, Frame, Gpu, Geometry, Surface, Target } from 'vgpu';
import { perspectiveCamera } from 'vgpu/scene';
import type { BrowserRendererOptions, ExampleRenderer, RenderSize, ThumbnailOptions } from '../../lib/example-renderer';
import { DEFAULT_INSTANCED_RENDERING_CONTROLS, type InstanceCount, type InstancedRenderingControls } from './types';
import sceneWgsl from './scene.wgsl'; import blitWgsl from './blit.wgsl';
type Output = Surface | Target; interface ThumbOptions extends ThumbnailOptions {} interface Scene { geometry: Geometry; draw: Draw; bundle: Bundle; extent: number }
const CLEAR = [0.008, 0.014, 0.035, 1] as const;
const validCount = (count: number): count is InstanceCount => count === 50 || count === 100;

export function createRenderer(options: BrowserRendererOptions<InstancedRenderingControls>): ExampleRenderer<InstancedRenderingControls> {
 let disposed = false, reportedError = false, generation = 0, initializing = true; let controls = { ...(options.initialControls ?? DEFAULT_INSTANCED_RENDERING_CONTROLS) }; if (!validCount(controls.count)) controls = { ...DEFAULT_INSTANCED_RENDERING_CONTROLS };
 let gpu: Gpu | undefined, surface: Surface | undefined, target: Target | undefined, blit: Effect | undefined, scene: Scene | undefined, loop: { stop(): void } | undefined, observer: ResizeObserver | undefined;
 let resizeFrame = 0, pendingSize: RenderSize | undefined, lastDpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio;
 const fail = (error: unknown) => { if (disposed) return; try { if (!reportedError) { reportedError = true; try { options.onError?.(error); } catch {} } } finally { dispose(); } };
 const applyResize = () => { resizeFrame = 0; const size = pendingSize; pendingSize = undefined; if (disposed || !size || !target || !blit || !surface) return; try { target.resize([Math.max(1, Math.round(size.width * size.dpr)), Math.max(1, Math.round(size.height * size.dpr))]); setBlitSource(blit, target, surface); } catch (error) { fail(error); } };
 const resize = (size: RenderSize) => { if (disposed || size.width <= 0 || size.height <= 0) return; pendingSize = size; if (!resizeFrame) resizeFrame = requestAnimationFrame(applyResize); };
 const measure = () => { const rect = options.canvas.getBoundingClientRect(); resize({ width: rect.width, height: rect.height, dpr: Math.min(2, Math.max(1, window.devicePixelRatio || 1)) }); };
 const onWindowResize = () => { if (window.devicePixelRatio === lastDpr) return; lastDpr = window.devicePixelRatio; measure(); };
 const rebuild = (count: InstanceCount, buildGeneration: number) => { if (!gpu || !target || disposed) return; void createScene(gpu, target, count).then((next) => { if (disposed || buildGeneration !== generation) { next.geometry.destroy(); return; } scene?.geometry.destroy(); scene = next; }, (error: unknown) => { if (disposed || buildGeneration !== generation) return; fail(error); }); };
 const setControls = (next: Readonly<InstancedRenderingControls>) => { if (disposed || !validCount(next.count) || next.count === controls.count) return; controls = { count: next.count }; const buildGeneration = ++generation; if (!initializing) rebuild(controls.count, buildGeneration); };
 const dispose = () => { if (disposed) return; disposed = true; generation++; loop?.stop(); loop = undefined; if (resizeFrame) cancelAnimationFrame(resizeFrame); resizeFrame = 0; pendingSize = undefined; observer?.disconnect(); observer = undefined; if (typeof window !== 'undefined') window.removeEventListener('resize', onWindowResize); scene?.geometry.destroy(); scene = undefined; (target as { destroy?: () => void } | undefined)?.destroy?.(); target = undefined; surface?.dispose(); surface = undefined; gpu?.dispose(); gpu = undefined; };
 const initialize = async () => { const { init } = await import('vgpu'); if (disposed) return; const nextGpu = await init(); if (disposed) { nextGpu.dispose(); return; } gpu = nextGpu; surface = gpu.surface(options.canvas, { dpr: [1, 2] }); target = gpu.target({ size: surface.size, format: 'rgba8unorm', depth: true }); blit = createBlit(gpu, target, surface); while (!disposed) { const buildGeneration = generation; let nextScene: Scene; try { nextScene = await createScene(gpu, target, controls.count); } catch (error) { if (disposed) return; if (buildGeneration !== generation) continue; throw error; } if (disposed) { nextScene.geometry.destroy(); return; } if (buildGeneration !== generation) { nextScene.geometry.destroy(); continue; } scene = nextScene; break; } if (disposed) return; initializing = false; observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure); observer?.observe(options.canvas); window.addEventListener('resize', onWindowResize); measure(); loop = gpu.frame.loop((frame) => { if (!disposed && scene && blit && target && surface && gpu) render(frame, scene, blit, target, surface, gpu.time); }); };
 const ready = initialize().catch((error: unknown) => { if (disposed) return; fail(error); throw error; });
 return { ready, setControls, invalidate() {}, resize, dispose };
}

export async function renderThumbnail(gpu: Gpu, output: Target, opts: ThumbOptions = {}): Promise<void> {
 let target: Target | undefined; let scene: Scene | undefined;
 try {
  target = gpu.target({ size: output.size, format: 'rgba8unorm', depth: true }); const blit = createBlit(gpu, target, output); scene = await createScene(gpu, target, DEFAULT_INSTANCED_RENDERING_CONTROLS.count); await blit.compile(output); let time = opts.time ?? 2.4;
  for (let i = 0; i < (opts.warmupFrames ?? 3); i++) { time += opts.dt ?? 1 / 60; gpu.frame((frame) => render(frame, scene!, blit, target!, output, time)); }
 } finally {
  await Promise.allSettled([gpu.gpu.queue.onSubmittedWorkDone(), gpu.settled()]); scene?.geometry.destroy(); (target as (Target & { destroy?: () => void }) | undefined)?.destroy?.();
 }
}

async function createScene(gpu: Gpu, target: Target, n: number): Promise<Scene> {
  const geometry = gpu.geometry({
    label: `instanced-cubes-${n}`,
    buffers: [
      { data: cubeVertices().buffer as ArrayBuffer, stride: 24, attributes: { local_position: 'float32x3', local_normal: 'float32x3' } },
      { data: makeInstances(n).buffer as ArrayBuffer, stride: 28, stepMode: 'instance', attributes: { i_position: 'float32x3', i_color: 'float32x3', i_seed: 'float32' } },
    ],
  });
  const draw = gpu.draw({ shader: sceneWgsl, geometry, label: `instanced-cubes-${n}` });
  draw.set({ light: [-0.45, -0.75, -0.35] });
  try {
    await draw.compile(target);
    const bundle = gpu.bundle({ target, label: `instanced-cubes-${n}` }, (b) => b.draw(draw));
    return { geometry, draw, bundle, extent: n * 0.64 };
  } catch (error) {
    geometry.destroy();
    throw error;
  }
}

function render(frame: Frame, scene: Scene, blit: Effect, target: Target, output: Output, time: number): void {
  const radius = scene.extent * 1.55;
  const angle = time * 0.06 + 0.55;
  const camera = perspectiveCamera({
    fov: 42, aspect: output.size[0] / Math.max(1, output.size[1]), near: 0.1, far: radius * 4,
    position: [Math.cos(angle) * radius, radius * 0.62, Math.sin(angle) * radius], target: [0, 0, 0],
  });
  scene.draw.set({ time, viewProjection: camera.viewProjection });
  frame.pass({ target, clear: CLEAR }, (p) => p.bundles(scene.bundle));
  frame.pass({ target: output }, (p) => p.draw(blit));
}

function createBlit(gpu: Gpu, source: Target, output: Output): Effect {
  const blit = gpu.effect(blitWgsl, { label: 'instanced-rendering-blit' });
  blit.set({ linear_samp: gpu.sampler({ minFilter: 'linear', magFilter: 'linear' }) });
  setBlitSource(blit, source, output);
  return blit;
}
function setBlitSource(blit: Effect, source: Target, output: Output): void {
  blit.set({ scene_tex: source, resolution: output.size });
}

function makeInstances(n: number): Float32Array {
  const data = new Float32Array(n * n * n * 7);
  const center = (n - 1) * 0.5;
  let o = 0;
  for (let z = 0; z < n; z++) for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    let h = Math.imul(x + 11, 73856093) ^ Math.imul(y + 17, 19349663) ^ Math.imul(z + 23, 83492791);
    h = (h ^ (h >>> 13)) >>> 0;
    const hue = (h % 1024) / 1024;
    const color = hue < .34 ? [.08, .7 + hue * .6, 1] : hue < .67 ? [1, .12, .68 + hue * .25] : [1, .55 + hue * .32, .08];
    data.set([(x - center) * .64, (y - center) * .64, (z - center) * .64, ...color, h / 0xffffffff], o);
    o += 7;
  }
  return data;
}

function cubeVertices(): Float32Array<ArrayBuffer> {
  const out: number[] = [];
  const faces = [
    [[1, 0, 0], [1, -1, -1], [1, 1, -1], [1, 1, 1], [1, -1, 1]], [[-1, 0, 0], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1], [-1, -1, -1]],
    [[0, 1, 0], [-1, 1, -1], [-1, 1, 1], [1, 1, 1], [1, 1, -1]], [[0, -1, 0], [-1, -1, 1], [-1, -1, -1], [1, -1, -1], [1, -1, 1]],
    [[0, 0, 1], [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]], [[0, 0, -1], [1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]],
  ] as const;
  for (const [normal, a, b, c, d] of faces) for (const p of [a, b, c, a, c, d]) out.push(p[0] * .18, p[1] * .18, p[2] * .18, ...normal);
  return new Float32Array(out);
}
