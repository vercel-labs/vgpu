import type { Draw, Effect, Frame, Gpu, Surface, Target } from 'vgpu';
import type { BrowserRendererOptions, ExampleRenderer, RenderSize, ThumbnailOptions } from '../../lib/example-renderer';
import { oceanCamera } from './camera';
import { createIfftStageTable, OCEAN_RESOLUTION, type IfftStage, type SimulationTargetName } from './ocean-graph';
import { gaussianCoefficients, OCEAN_TUNING } from './tuning';
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
import { clock, draw, effect, frame, frameLoop, sampler, surface, target } from "vgpu";

type Output = Surface | Target;
interface ThumbOptions extends ThumbnailOptions {
  onVariantRendered?: (variant: 'time-delta', pixels: Uint8Array, size: readonly [number, number]) => void | Promise<void>;
  onIntermediateRendered?: (kind: 'displacement', pixels: Uint8Array, size: readonly [number, number]) => void | Promise<void>;
}
interface StageEffect { readonly spec: IfftStage; readonly effect: Effect; readonly output: Target }
interface BloomLevel { readonly horizontal: Target; readonly vertical: Target; readonly horizontalEffect: Effect; readonly verticalEffect: Effect }
interface OceanGraph {
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
const BLOOM_LEVELS = OCEAN_TUNING.bloom.levels;

export function createRenderer(options: BrowserRendererOptions): ExampleRenderer {
  let disposed = false;
  let reportedError = false;
  let gpu: Gpu | undefined;
  let canvasSurface: Surface | undefined;
  let graph: OceanGraph | undefined;
  let loop: { stop(): void } | undefined;
  let observer: ResizeObserver | undefined;
  let resizeFrame = 0;
  let pendingSize: RenderSize | undefined;
  let lastDpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio;

  const applyResize = () => {
    resizeFrame = 0;
    const size = pendingSize;
    pendingSize = undefined;
    if (disposed || !size || !graph || !canvasSurface) return;
    resizeOutputGraph(graph, canvasSurface);
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
    if (graph) destroyGraph(graph);
    graph = undefined;
    canvasSurface?.dispose();
    canvasSurface = undefined;
    gpu?.dispose();
    gpu = undefined;
  };
  const initialize = async () => {
    const { init } = await import('vgpu');
    if (disposed) return;
    const nextGpu = await init();
    if (disposed) { nextGpu.dispose(); return; }
    gpu = nextGpu;
    canvasSurface = surface(gpu, options.canvas, { dpr: [1, 1.6] });
    const nextGraph = await createGraph(gpu, canvasSurface, 'fft-ocean-live');
    if (disposed) { destroyGraph(nextGraph); return; }
    graph = nextGraph;
    observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure);
    observer?.observe(options.canvas);
    window.addEventListener('resize', onWindowResize);
    measure();
    const time = clock(gpu);
    loop = frameLoop(gpu, (currentFrame) => {
      if (disposed || !graph || !gpu || !canvasSurface) return;
      setDynamics(graph, time.time * OCEAN_TUNING.simulation.timeScale);
      renderGraph(currentFrame, graph, canvasSurface);
    });
  };
  const ready = initialize().catch((error: unknown) => {
    if (disposed) return;
    if (!reportedError) { reportedError = true; options.onError?.(error); }
    dispose();
    throw error;
  });
  return { ready, invalidate() {}, resize, dispose };
}

export async function renderThumbnail(gpu: Gpu, output: Target, opts: ThumbOptions = {}): Promise<void> {
  const graph = await createGraph(gpu, output, 'fft-ocean-thumb');
  try {
    const time = opts.time ?? 18;
    renderAt(gpu, graph, output, time);
    await gpu.gpu.queue.onSubmittedWorkDone();
    if (opts.onIntermediateRendered) {
      const displacement = graph.ifft.at(-1)!.output;
      const previewTarget = target(gpu, { size: displacement.size, format: 'rgba8unorm', label: 'fft-ocean-displacement-preview' });
      try {
        const preview = effect(gpu, stagePreviewWgsl, { label: 'fft-ocean-displacement-preview' });
        preview.set({ u: { outputWidth: displacement.size[0], outputHeight: displacement.size[1], stage: 1, gain: 16 }, u_input: displacement });
        await preview.compile(previewTarget);
        frame(gpu, (currentFrame) => currentFrame.pass({ target: previewTarget, clear: CLEAR }, (pass) => pass.draw(preview)));
        await gpu.gpu.queue.onSubmittedWorkDone();
        await opts.onIntermediateRendered('displacement', await previewTarget.read(), previewTarget.size);
      } finally {
        try {
          await gpu.gpu.queue.onSubmittedWorkDone();
        } finally {
          previewTarget.color.destroy();
        }
      }
    }
    renderAt(gpu, graph, output, time + 5);
    await gpu.gpu.queue.onSubmittedWorkDone();
    await opts.onVariantRendered?.('time-delta', await output.read(), output.size);
    renderAt(gpu, graph, output, time);
    await gpu.gpu.queue.onSubmittedWorkDone();
    await gpu.settled();
  } finally {
    try {
      await gpu.gpu.queue.onSubmittedWorkDone();
    } finally {
      destroyGraph(graph);
    }
  }
}

async function createGraph(gpu: Gpu, output: Output, label: string): Promise<OceanGraph> {
  const ownedTargets: Target[] = [];
  const own = (colorTarget: Target) => { ownedTargets.push(colorTarget); return colorTarget; };
  try {
  const resolution = OCEAN_RESOLUTION;
  const simTarget = (name: string) => own(target(gpu, { size: [resolution, resolution], format: SIM_FORMAT, label: `${label}-${name}` }));
  const noise = simTarget('noise'), h0 = simTarget('h0'), spectrum = simTarget('spectrum'), ping = simTarget('ping'), pong = simTarget('pong'), normalFoam = simTarget('normal-foam');
  const scene = own(target(gpu, { size: normalizedSize(output.size), format: HDR_FORMAT, label: `${label}-scene` }));
  const sizes = bloomSizes(output.size);
  const bright = own(target(gpu, { size: sizes[0]!, format: HDR_FORMAT, label: `${label}-bright` }));
  const composite = own(target(gpu, { size: sizes[0]!, format: HDR_FORMAT, label: `${label}-composite` }));
  const samplerState = sampler(gpu, { minFilter: 'linear', magFilter: 'linear' });
  const noiseEffect = effect(gpu, noiseWgsl, { label: `${label}-noise` });
  noiseEffect.set({ u: { seed: 0x6f636561, resolution } });
  const initialSpectrum = effect(gpu, initialSpectrumWgsl, { label: `${label}-initial-spectrum` });
  initialSpectrum.set({ u: { resolution, size: OCEAN_TUNING.simulation.oceanSize, windSpeed: OCEAN_TUNING.simulation.windSpeed, windAngle: OCEAN_TUNING.simulation.windAngle, amplitude: OCEAN_TUNING.simulation.amplitude }, u_noise: noise });
  const evolveSpectrum = effect(gpu, spectrumWgsl, { label: `${label}-spectrum` });
  evolveSpectrum.set({ u: { resolution, size: OCEAN_TUNING.simulation.oceanSize, time: 0, choppiness: OCEAN_TUNING.simulation.choppiness }, u_initialSpectrum: h0 });
  const targets: Record<SimulationTargetName, Target> = { spectrum, ping, pong };
  const ifft = createIfftStageTable().map((spec) => {
    const shader1 = effect(gpu, ifftStageWgsl, { label: `${label}-ifft-${spec.index}-${spec.horizontal ? 'h' : 'v'}` });
    shader1.set({ u: { resolution, subtransformSize: spec.subtransformSize, horizontal: spec.horizontal ? 1 : 0 }, u_input: targets[spec.input] });
    return { spec, effect: shader1, output: targets[spec.output] };
  });
  const displacement = targets[ifft.at(-1)!.spec.output];
  const normals = effect(gpu, normalFoamWgsl, { label: `${label}-normal-foam` });
  normals.set({ u: { resolution, worldSize: OCEAN_TUNING.simulation.worldSize, displacementScale: OCEAN_TUNING.simulation.displacementScale, choppiness: OCEAN_TUNING.simulation.choppiness, foamThreshold: OCEAN_TUNING.simulation.foamThreshold }, u_displacement: displacement });
  const particles = draw(gpu, {
    shader: particlesWgsl,
    vertices: 6,
    instances: resolution * resolution,
    blend: { color: { src: 'src-alpha', dst: 'one' }, alpha: { src: 'one', dst: 'one' } },
    label: `${label}-particles`,
  });
  particles.set({ u_displacement: displacement, u_normalFoam: normalFoam });
  setParticleConstants(particles, output);
  const brightEffect = effect(gpu, bloomBrightWgsl, { label: `${label}-bloom-bright` });
  brightEffect.set({ uniforms: { luminosityThreshold: OCEAN_TUNING.bloom.threshold, smoothWidth: OCEAN_TUNING.bloom.smoothWidth }, tDiffuse: scene, linearSampler: samplerState });
  let bloomInput = bright;
  const levels = sizes.map((size, index) => {
    const horizontal = own(target(gpu, { size, format: HDR_FORMAT, label: `${label}-bloom-h${index}` }));
    const vertical = own(target(gpu, { size, format: HDR_FORMAT, label: `${label}-bloom-v${index}` }));
    const kernelRadius = OCEAN_TUNING.bloom.kernelRadii[index]!;
    const horizontalEffect = makeBlur(gpu, `${label}-blur-h${index}`, bloomInput, horizontal, samplerState, [1, 0], kernelRadius);
    const verticalEffect = makeBlur(gpu, `${label}-blur-v${index}`, horizontal, vertical, samplerState, [0, 1], kernelRadius);
    bloomInput = vertical;
    return { horizontal, vertical, horizontalEffect, verticalEffect };
  });
  const compositeEffect = effect(gpu, bloomCompositeWgsl, { label: `${label}-bloom-composite` });
  compositeEffect.set({
    uniforms: { bloomStrength: OCEAN_TUNING.bloom.strength, bloomRadius: OCEAN_TUNING.bloom.radius, bloomFactors0: [1, 0.8, 0.6, 0.4], bloomFactors1: [0.2, 0, 0, 0] },
    blurTexture1: levels[0]!.vertical, blurTexture2: levels[1]!.vertical, blurTexture3: levels[2]!.vertical,
    blurTexture4: levels[3]!.vertical, blurTexture5: levels[4]!.vertical, linearSampler: samplerState,
  });
  const present = effect(gpu, presentWgsl, { label: `${label}-present` });
  present.set({ sceneHDR: scene, bloomTexture: composite, linearSampler: samplerState });
  const graph: OceanGraph = { noise, h0, spectrum, ping, pong, normalFoam, scene, bright, composite, levels, noiseEffect, initialSpectrum, evolveSpectrum, ifft, normals, particles, brightEffect, compositeEffect, present, needsInitialSpectrum: true };
  await prewarm(graph, output);
  return graph;
  } catch (error) {
    for (let i = ownedTargets.length - 1; i >= 0; i--) ownedTargets[i]!.color.destroy();
    throw error;
  }
}

function makeBlur(gpu: Gpu, label: string, source: Target, colorTarget: Target, samplerState: GPUSampler, direction: readonly [number, number], kernelRadius: number): Effect {
  const shader1 = effect(gpu, bloomBlurWgsl, { label });
  const c = gaussianCoefficients(kernelRadius);
  shader1.set({ uniforms: { direction, invSize: colorTarget.texelSize, gaussianCoefficients0: c.slice(0, 4), gaussianCoefficients1: c.slice(4, 8), gaussianCoefficients2: c.slice(8, 12), gaussianCoefficients3: c.slice(12, 16), gaussianCoefficients4: c.slice(16, 20), gaussianCoefficients5: c.slice(20, 24) }, colorTexture: source, linearSampler: samplerState });
  return shader1;
}

async function prewarm(g: OceanGraph, output: Output): Promise<void> {
  await Promise.all([
    g.noiseEffect.compile(g.noise), g.initialSpectrum.compile(g.h0), g.evolveSpectrum.compile(g.spectrum), ...g.ifft.map((s) => s.effect.compile(s.output)), g.normals.compile(g.normalFoam),
    g.particles.compile(g.scene), g.brightEffect.compile(g.bright),
    ...g.levels.flatMap((level) => [level.horizontalEffect.compile(level.horizontal), level.verticalEffect.compile(level.vertical)]),
    g.compositeEffect.compile(g.composite), g.present.compile({ colors: [output.format] }),
  ]);
}

function setDynamics(g: OceanGraph, timeSeconds: number): void {
  g.evolveSpectrum.set({ u: { time: timeSeconds * OCEAN_TUNING.simulation.spectrumTimeScale } });
}
function setParticleConstants(drawable: Draw, output: Output): void {
  const resolution = OCEAN_RESOLUTION;
  const camera = oceanCamera(output.size);
  const particles = OCEAN_TUNING.particles;
  const simulation = OCEAN_TUNING.simulation;
  drawable.set({ u: {
    view: camera.view,
    projection: camera.projection,
    viewport: [output.size[0], output.size[1], 1, resolution],
    simulation: [simulation.worldSize, simulation.oceanSize, simulation.gravity, 0],
    fade: [particles.fadeNear, particles.fadeFar, particles.fadePower, 0],
    oceanColor: particles.oceanColor,
    neonColor: particles.neonColor,
    foamColor: particles.foamColor,
    misc: [simulation.displacementScale, particles.pointSize, 0, 0],
  } });
}
function renderAt(gpu: Gpu, graph: OceanGraph, output: Target, time: number): void { setDynamics(graph, time); frame(gpu, (currentFrame) => renderGraph(currentFrame, graph, output)); }
function renderGraph(currentFrame: Frame, g: OceanGraph, output: Output): void {
  if (g.needsInitialSpectrum) {
    currentFrame.pass({ target: g.noise, clear: TRANSPARENT }, (p) => p.draw(g.noiseEffect));
    currentFrame.pass({ target: g.h0, clear: TRANSPARENT }, (p) => p.draw(g.initialSpectrum));
    g.needsInitialSpectrum = false;
  }
  currentFrame.pass({ target: g.spectrum, clear: TRANSPARENT }, (p) => p.draw(g.evolveSpectrum));
  for (const stage of g.ifft) currentFrame.pass({ target: stage.output, clear: TRANSPARENT }, (p) => p.draw(stage.effect));
  currentFrame.pass({ target: g.normalFoam, clear: TRANSPARENT }, (p) => p.draw(g.normals));
  currentFrame.pass({ target: g.scene, clear: TRANSPARENT }, (p) => p.draw(g.particles));
  currentFrame.pass({ target: g.bright, clear: TRANSPARENT }, (p) => p.draw(g.brightEffect));
  for (const level of g.levels) {
    currentFrame.pass({ target: level.horizontal, clear: TRANSPARENT }, (p) => p.draw(level.horizontalEffect));
    currentFrame.pass({ target: level.vertical, clear: TRANSPARENT }, (p) => p.draw(level.verticalEffect));
  }
  currentFrame.pass({ target: g.composite, clear: TRANSPARENT }, (p) => p.draw(g.compositeEffect));
  currentFrame.pass({ target: output, clear: TRANSPARENT }, (p) => p.draw(g.present));
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
  const camera = oceanCamera(output.size);
  g.particles.set({ u: { view: camera.view, projection: camera.projection, viewport: [output.size[0], output.size[1], 1, OCEAN_RESOLUTION] } });
}
function bloomSizes(size: readonly [number, number]): [number, number][] {
  let w = Math.max(1, Math.round(size[0] / 2)), h = Math.max(1, Math.round(size[1] / 2)); const out: [number, number][] = [];
  for (let i = 0; i < BLOOM_LEVELS; i++) { out.push([w, h]); w = Math.max(1, Math.round(w / 2)); h = Math.max(1, Math.round(h / 2)); }
  return out;
}
function normalizedSize(size: readonly [number, number]): [number, number] { return [Math.max(1, Math.floor(size[0])), Math.max(1, Math.floor(size[1]))]; }
function destroyGraph(g: OceanGraph): void { for (const colorTarget of [g.noise, g.h0, g.spectrum, g.ping, g.pong, g.normalFoam, g.scene, g.bright, g.composite, ...g.levels.flatMap((x) => [x.horizontal, x.vertical])]) colorTarget.color.destroy(); }
