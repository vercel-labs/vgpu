import type { Draw, Effect, Frame, Gpu, Surface, Target } from 'vgpu';
import { oceanCamera } from './camera';
import { createIfftStageTable, type IfftStage, type SimulationTargetName } from './ocean-graph';
import noiseWgsl from './noise.wgsl';
import initialSpectrumWgsl from './initial-spectrum.wgsl';
import spectrumWgsl from './spectrum.wgsl';
import ifftStageWgsl from './ifft-stage.wgsl';
import normalFoamWgsl from './normal-foam.wgsl';
import particlesWgsl from './particles.wgsl';
import bloomBrightWgsl from './bloom-bright.wgsl';
import bloomBlurWgsl from './bloom-blur.wgsl';
import bloomCompositeWgsl from './bloom-composite.wgsl';
import presentWgsl from './present.wgsl';
import stagePreviewWgsl from './stage-preview.wgsl';

type Output = Surface | Target;
type Orbit = readonly [number, number];
type Resolution = 256 | 512;
interface ThumbOptions {
  time?: number;
  onVariantRendered?: (variant: 'time-delta' | 'pointer-orbit', pixels: Uint8Array, size: readonly [number, number]) => void | Promise<void>;
  onIntermediateRendered?: (kind: 'displacement', pixels: Uint8Array, size: readonly [number, number]) => void | Promise<void>;
}
interface StageEffect { readonly spec: IfftStage; readonly effect: Effect; readonly output: Target }
interface BloomLevel { readonly horizontal: Target; readonly vertical: Target; readonly horizontalEffect: Effect; readonly verticalEffect: Effect }
interface OceanGraph {
  readonly resolution: Resolution;
  readonly noise: Target; readonly h0: Target; readonly spectrum: Target; readonly ping: Target; readonly pong: Target; readonly normalFoam: Target;
  readonly scene: Target; readonly bright: Target; readonly composite: Target;
  readonly levels: readonly BloomLevel[];
  readonly noiseEffect: Effect; readonly initialSpectrum: Effect; readonly evolveSpectrum: Effect; readonly ifft: readonly StageEffect[]; readonly normals: Effect;
  readonly particles: Draw; readonly brightEffect: Effect; readonly compositeEffect: Effect; readonly present: Effect;
  needsInitialSpectrum: boolean;
}

const SIM_FORMAT: GPUTextureFormat = 'rgba32float';
const HDR_FORMAT: GPUTextureFormat = 'rgba16float';
const CLEAR = [0, 0, 0, 1] as const;
const TRANSPARENT = [0, 0, 0, 0] as const;
const POSTER_ORBIT: Orbit = [0, 0];
const BLOOM_LEVELS = 5;

export async function run(canvas: HTMLCanvasElement): Promise<() => void> {
  const { init } = await import('vgpu');
  const gpu = await init();
  const surface = gpu.surface(canvas, { dpr: [1, 1.6] });
  let graph = await createGraph(gpu, surface, 256, 'fft-ocean-live');
  const input = installOrbitInput(canvas);
  let disposed = false;
  const selector = installResolutionSelect(canvas, async (resolution) => {
    const next = await createGraph(gpu, surface, resolution, `fft-ocean-live-${resolution}`);
    if (disposed) { destroyGraph(next); return; }
    const old = graph; graph = next; destroyGraph(old);
  });
  let sawInitialResize = false;
  const unsubscribeResize = surface.onResize(() => {
    if (!sawInitialResize) { sawInitialResize = true; return; }
    if (disposed) return;
    resizeOutputGraph(graph, surface);
  });
  const loop = gpu.frame.loop((frame) => {
    const orbit = input.update();
    setDynamics(graph, surface, gpu.time * 0.6, orbit);
    renderGraph(frame, graph, surface);
  });
  return () => {
    if (disposed) return;
    disposed = true;
    loop.stop(); unsubscribeResize(); input.dispose(); selector.remove();
    destroyGraph(graph); surface.dispose(); gpu.dispose();
  };
}

export async function renderThumb(gpu: Gpu, output: Target, opts: ThumbOptions = {}): Promise<void> {
  const graph = await createGraph(gpu, output, 256, 'fft-ocean-thumb');
  const time = opts.time ?? 18;
  renderAt(gpu, graph, output, time, POSTER_ORBIT);
  await gpu.gpu.queue.onSubmittedWorkDone();
  if (opts.onIntermediateRendered) {
    const displacement = graph.ifft.at(-1)!.output;
    const previewTarget = gpu.target({ size: displacement.size, format: 'rgba8unorm', label: 'fft-ocean-displacement-preview' });
    const preview = gpu.effect(stagePreviewWgsl, { label: 'fft-ocean-displacement-preview' });
    preview.set({ u: { outputWidth: displacement.size[0], outputHeight: displacement.size[1], stage: 1, gain: 16 }, u_input: displacement });
    await preview.compile(previewTarget);
    gpu.frame((frame) => frame.pass({ target: previewTarget, clear: CLEAR }, (pass) => pass.draw(preview)));
    await gpu.gpu.queue.onSubmittedWorkDone();
    await opts.onIntermediateRendered('displacement', await previewTarget.read(), previewTarget.size);
    previewTarget.color.destroy();
  }
  renderAt(gpu, graph, output, time + 5, POSTER_ORBIT);
  await gpu.gpu.queue.onSubmittedWorkDone();
  await opts.onVariantRendered?.('time-delta', await output.read(), output.size);
  renderAt(gpu, graph, output, time, [0.55, 0.24]);
  await gpu.gpu.queue.onSubmittedWorkDone();
  await opts.onVariantRendered?.('pointer-orbit', await output.read(), output.size);
  renderAt(gpu, graph, output, time, POSTER_ORBIT);
  await gpu.gpu.queue.onSubmittedWorkDone();
  await gpu.settled();
  destroyGraph(graph);
}

async function createGraph(gpu: Gpu, output: Output, resolution: Resolution, label: string): Promise<OceanGraph> {
  const simTarget = (name: string) => gpu.target({ size: [resolution, resolution], format: SIM_FORMAT, label: `${label}-${name}` });
  const noise = simTarget('noise'), h0 = simTarget('h0'), spectrum = simTarget('spectrum'), ping = simTarget('ping'), pong = simTarget('pong'), normalFoam = simTarget('normal-foam');
  const scene = gpu.target({ size: normalizedSize(output.size), format: HDR_FORMAT, label: `${label}-scene` });
  const sizes = bloomSizes(output.size);
  const bright = gpu.target({ size: sizes[0]!, format: HDR_FORMAT, label: `${label}-bright` });
  const composite = gpu.target({ size: sizes[0]!, format: HDR_FORMAT, label: `${label}-composite` });
  const sampler = gpu.sampler({ minFilter: 'linear', magFilter: 'linear' });
  const noiseEffect = gpu.effect(noiseWgsl, { label: `${label}-noise` });
  noiseEffect.set({ u: { seed: 0x6f636561 } });
  const initialSpectrum = gpu.effect(initialSpectrumWgsl, { label: `${label}-initial-spectrum` });
  initialSpectrum.set({ u: { resolution, size: 200, windSpeed: 12.9, windAngle: 4.83, amplitude: 1.3 }, u_noise: noise });
  const evolveSpectrum = gpu.effect(spectrumWgsl, { label: `${label}-spectrum` });
  evolveSpectrum.set({ u: { resolution, size: 200, time: 0, choppiness: 1.51 }, u_initialSpectrum: h0 });
  const targets: Record<SimulationTargetName, Target> = { spectrum, ping, pong };
  const ifft = createIfftStageTable(resolution).map((spec) => {
    const effect = gpu.effect(ifftStageWgsl, { label: `${label}-ifft-${spec.index}-${spec.horizontal ? 'h' : 'v'}` });
    effect.set({ u: { resolution, subtransformSize: spec.subtransformSize, horizontal: spec.horizontal ? 1 : 0 }, u_input: targets[spec.input] });
    return { spec, effect, output: targets[spec.output] };
  });
  const displacement = targets[ifft.at(-1)!.spec.output];
  const normals = gpu.effect(normalFoamWgsl, { label: `${label}-normal-foam` });
  normals.set({ u: { resolution, worldSize: 400, displacementScale: 0.005, choppiness: 1.51, foamThreshold: 0 }, u_displacement: displacement });
  const particles = gpu.draw({ shader: particlesWgsl, vertices: 6, instances: resolution * resolution, blend: 'additive', label: `${label}-particles` });
  particles.set({ u_displacement: displacement, u_normalFoam: normalFoam });
  setParticleConstants(particles, output, resolution, POSTER_ORBIT);
  const brightEffect = gpu.effect(bloomBrightWgsl, { label: `${label}-bloom-bright` });
  brightEffect.set({ uniforms: { luminosityThreshold: 0.3, smoothWidth: 0.35 }, tDiffuse: scene, linearSampler: sampler });
  let bloomInput = bright;
  const levels = sizes.map((size, index) => {
    const horizontal = gpu.target({ size, format: HDR_FORMAT, label: `${label}-bloom-h${index}` });
    const vertical = gpu.target({ size, format: HDR_FORMAT, label: `${label}-bloom-v${index}` });
    const horizontalEffect = makeBlur(gpu, `${label}-blur-h${index}`, bloomInput, horizontal, sampler, [1, 0]);
    const verticalEffect = makeBlur(gpu, `${label}-blur-v${index}`, horizontal, vertical, sampler, [0, 1]);
    bloomInput = vertical;
    return { horizontal, vertical, horizontalEffect, verticalEffect };
  });
  const compositeEffect = gpu.effect(bloomCompositeWgsl, { label: `${label}-bloom-composite` });
  compositeEffect.set({
    uniforms: { bloomStrength: 0.18, bloomRadius: 0.46, bloomFactors0: [1, 0.8, 0.6, 0.4], bloomFactors1: [0.2, 0, 0, 0] },
    blurTexture1: levels[0]!.vertical, blurTexture2: levels[1]!.vertical, blurTexture3: levels[2]!.vertical,
    blurTexture4: levels[3]!.vertical, blurTexture5: levels[4]!.vertical, linearSampler: sampler,
  });
  const present = gpu.effect(presentWgsl, { label: `${label}-present` });
  present.set({ sceneHDR: scene, bloomTexture: composite, linearSampler: sampler });
  const graph: OceanGraph = { resolution, noise, h0, spectrum, ping, pong, normalFoam, scene, bright, composite, levels, noiseEffect, initialSpectrum, evolveSpectrum, ifft, normals, particles, brightEffect, compositeEffect, present, needsInitialSpectrum: true };
  await prewarm(graph, output);
  return graph;
}

function makeBlur(gpu: Gpu, label: string, source: Target, target: Target, sampler: GPUSampler, direction: readonly [number, number]): Effect {
  const effect = gpu.effect(bloomBlurWgsl, { label });
  const c = [0.227, 0.194, 0.121, 0.054, 0.016, 0.003] as const;
  effect.set({ uniforms: { direction, invSize: target.texelSize, gaussianCoefficients0: [c[0], c[1], c[2], c[3]], gaussianCoefficients1: [c[4], c[5], 0, 0], gaussianCoefficients2: [0, 0, 0, 0], gaussianCoefficients3: [0, 0, 0, 0], gaussianCoefficients4: [0, 0, 0, 0], gaussianCoefficients5: [0, 0, 0, 0] }, colorTexture: source, linearSampler: sampler });
  return effect;
}

async function prewarm(g: OceanGraph, output: Output): Promise<void> {
  await Promise.all([
    g.noiseEffect.compile(g.noise), g.initialSpectrum.compile(g.h0), g.evolveSpectrum.compile(g.spectrum), ...g.ifft.map((s) => s.effect.compile(s.output)), g.normals.compile(g.normalFoam),
    g.particles.compile(g.scene), g.brightEffect.compile(g.bright),
    ...g.levels.flatMap((level) => [level.horizontalEffect.compile(level.horizontal), level.verticalEffect.compile(level.vertical)]),
    g.compositeEffect.compile(g.composite), g.present.compile({ colors: [output.format] }),
  ]);
}

function setDynamics(g: OceanGraph, output: Output, time: number, orbit: Orbit): void {
  g.evolveSpectrum.set({ u: { time } });
  const camera = oceanCamera(output.size, orbit);
  g.particles.set({ u: { view: camera.view, projection: camera.projection } });
}
function setParticleConstants(draw: Draw, output: Output, resolution: Resolution, orbit: Orbit): void {
  const camera = oceanCamera(output.size, orbit);
  draw.set({ u: { view: camera.view, projection: camera.projection, viewport: [output.size[0], output.size[1], 1, resolution], simulation: [400, 200, 0, 0], fade: [60, 210, 2.4, 160], oceanColor: [0.003, 0.005, 0.009, 1], neonColor: [2.8, 3.1, 3.5, 1], foamColor: [4, 4, 4, 1], misc: [0.005, 0.9, 0, 0] } });
}
function renderAt(gpu: Gpu, graph: OceanGraph, output: Target, time: number, orbit: Orbit): void { setDynamics(graph, output, time, orbit); gpu.frame((frame) => renderGraph(frame, graph, output)); }
function renderGraph(frame: Frame, g: OceanGraph, output: Output): void {
  if (g.needsInitialSpectrum) {
    frame.pass({ target: g.noise, clear: TRANSPARENT }, (p) => p.draw(g.noiseEffect));
    frame.pass({ target: g.h0, clear: TRANSPARENT }, (p) => p.draw(g.initialSpectrum));
    g.needsInitialSpectrum = false;
  }
  frame.pass({ target: g.spectrum, clear: TRANSPARENT }, (p) => p.draw(g.evolveSpectrum));
  for (const stage of g.ifft) frame.pass({ target: stage.output, clear: TRANSPARENT }, (p) => p.draw(stage.effect));
  frame.pass({ target: g.normalFoam, clear: TRANSPARENT }, (p) => p.draw(g.normals));
  frame.pass({ target: g.scene, clear: CLEAR }, (p) => p.draw(g.particles));
  frame.pass({ target: g.bright, clear: TRANSPARENT }, (p) => p.draw(g.brightEffect));
  for (const level of g.levels) {
    frame.pass({ target: level.horizontal, clear: TRANSPARENT }, (p) => p.draw(level.horizontalEffect));
    frame.pass({ target: level.vertical, clear: TRANSPARENT }, (p) => p.draw(level.verticalEffect));
  }
  frame.pass({ target: g.composite, clear: TRANSPARENT }, (p) => p.draw(g.compositeEffect));
  frame.pass({ target: output, clear: CLEAR }, (p) => p.draw(g.present));
}

function resizeOutputGraph(g: OceanGraph, output: Output): void {
  g.scene.resize(normalizedSize(output.size));
  const sizes = bloomSizes(output.size); g.bright.resize(sizes[0]!); g.composite.resize(sizes[0]!);
  for (let i = 0; i < g.levels.length; i++) { g.levels[i]!.horizontal.resize(sizes[i]!); g.levels[i]!.vertical.resize(sizes[i]!); }
  g.brightEffect.set({ tDiffuse: g.scene });
  let input = g.bright;
  for (const level of g.levels) {
    level.horizontalEffect.set({ colorTexture: input, uniforms: { invSize: level.horizontal.texelSize } });
    level.verticalEffect.set({ colorTexture: level.horizontal, uniforms: { invSize: level.vertical.texelSize } }); input = level.vertical;
  }
  g.compositeEffect.set({ blurTexture1: g.levels[0]!.vertical, blurTexture2: g.levels[1]!.vertical, blurTexture3: g.levels[2]!.vertical, blurTexture4: g.levels[3]!.vertical, blurTexture5: g.levels[4]!.vertical });
  g.present.set({ sceneHDR: g.scene, bloomTexture: g.composite });
  const camera = oceanCamera(output.size, POSTER_ORBIT);
  g.particles.set({ u: { view: camera.view, projection: camera.projection, viewport: [output.size[0], output.size[1], 1, g.resolution] } });
}
function bloomSizes(size: readonly [number, number]): [number, number][] {
  let w = Math.max(1, Math.round(size[0] / 2)), h = Math.max(1, Math.round(size[1] / 2)); const out: [number, number][] = [];
  for (let i = 0; i < BLOOM_LEVELS; i++) { out.push([w, h]); w = Math.max(1, Math.round(w / 2)); h = Math.max(1, Math.round(h / 2)); }
  return out;
}
function normalizedSize(size: readonly [number, number]): [number, number] { return [Math.max(1, Math.floor(size[0])), Math.max(1, Math.floor(size[1]))]; }
function destroyGraph(g: OceanGraph): void { for (const target of [g.noise, g.h0, g.spectrum, g.ping, g.pong, g.normalFoam, g.scene, g.bright, g.composite, ...g.levels.flatMap((x) => [x.horizontal, x.vertical])]) target.color.destroy(); }

function installOrbitInput(canvas: HTMLCanvasElement) {
  let yaw = 0, pitch = 0, targetYaw = 0, targetPitch = 0; const previous = canvas.style.touchAction; canvas.style.touchAction = 'none';
  const move = (event: PointerEvent) => { if (!event.isPrimary) return; const rect = canvas.getBoundingClientRect(); const x = (event.clientX - rect.left) / Math.max(1, rect.width); const y = (event.clientY - rect.top) / Math.max(1, rect.height); targetYaw = (0.5 - Math.max(0, Math.min(1, x))) * 1.3; targetPitch = (Math.max(0, Math.min(1, y)) - 0.5) * 0.55; };
  canvas.addEventListener('pointermove', move);
  return { update(): Orbit { yaw += (targetYaw - yaw) * 0.1; pitch += (targetPitch - pitch) * 0.1; return [yaw, pitch]; }, dispose() { canvas.removeEventListener('pointermove', move); canvas.style.touchAction = previous; } };
}
function installResolutionSelect(canvas: HTMLCanvasElement, change: (resolution: Resolution) => Promise<void>): HTMLSelectElement {
  const select = document.createElement('select'); select.title = 'FFT simulation resolution';
  select.innerHTML = '<option value="256">256² (default)</option><option value="512">512² (262k — high quality)</option>';
  select.style.cssText = 'position:absolute;top:12px;right:12px;padding:6px 9px;border:1px solid #343944;border-radius:6px;background:#080a0e;color:#e8edf5;font:12px system-ui;z-index:2'; canvas.parentElement?.append(select);
  select.addEventListener('change', async () => { select.disabled = true; try { await change(Number(select.value) as Resolution); } finally { select.disabled = false; } }); return select;
}
