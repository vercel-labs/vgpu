import type { Draw, Effect, Frame, Gpu, Surface, Target } from 'vgpu';
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

type Output = Surface | Target;
interface ThumbOptions {
  time?: number;
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

export async function run(canvas: HTMLCanvasElement): Promise<() => void> {
  const { init } = await import('vgpu');
  const gpu = await init();
  const surface = gpu.surface(canvas, { dpr: [1, 1.6] });
  const graph = await createGraph(gpu, surface, 'fft-ocean-live');
  let disposed = false;
  let sawInitialResize = false;
  const unsubscribeResize = surface.onResize(() => {
    if (!sawInitialResize) { sawInitialResize = true; return; }
    if (disposed) return;
    resizeOutputGraph(graph, surface);
  });
  const loop = gpu.frame.loop((frame) => {
    setDynamics(graph, gpu.time * OCEAN_TUNING.simulation.timeScale);
    renderGraph(frame, graph, surface);
  });
  return () => {
    if (disposed) return;
    disposed = true;
    loop.stop(); unsubscribeResize();
    destroyGraph(graph); surface.dispose(); gpu.dispose();
  };
}

export async function renderThumb(gpu: Gpu, output: Target, opts: ThumbOptions = {}): Promise<void> {
  const graph = await createGraph(gpu, output, 'fft-ocean-thumb');
  const time = opts.time ?? 18;
  renderAt(gpu, graph, output, time);
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
  renderAt(gpu, graph, output, time + 5);
  await gpu.gpu.queue.onSubmittedWorkDone();
  await opts.onVariantRendered?.('time-delta', await output.read(), output.size);
  renderAt(gpu, graph, output, time);
  await gpu.gpu.queue.onSubmittedWorkDone();
  await gpu.settled();
  destroyGraph(graph);
}

async function createGraph(gpu: Gpu, output: Output, label: string): Promise<OceanGraph> {
  const resolution = OCEAN_RESOLUTION;
  const simTarget = (name: string) => gpu.target({ size: [resolution, resolution], format: SIM_FORMAT, label: `${label}-${name}` });
  const noise = simTarget('noise'), h0 = simTarget('h0'), spectrum = simTarget('spectrum'), ping = simTarget('ping'), pong = simTarget('pong'), normalFoam = simTarget('normal-foam');
  const scene = gpu.target({ size: normalizedSize(output.size), format: HDR_FORMAT, label: `${label}-scene` });
  const sizes = bloomSizes(output.size);
  const bright = gpu.target({ size: sizes[0]!, format: HDR_FORMAT, label: `${label}-bright` });
  const composite = gpu.target({ size: sizes[0]!, format: HDR_FORMAT, label: `${label}-composite` });
  const sampler = gpu.sampler({ minFilter: 'linear', magFilter: 'linear' });
  const noiseEffect = gpu.effect(noiseWgsl, { label: `${label}-noise` });
  noiseEffect.set({ u: { seed: 0x6f636561, resolution } });
  const initialSpectrum = gpu.effect(initialSpectrumWgsl, { label: `${label}-initial-spectrum` });
  initialSpectrum.set({ u: { resolution, size: OCEAN_TUNING.simulation.oceanSize, windSpeed: OCEAN_TUNING.simulation.windSpeed, windAngle: OCEAN_TUNING.simulation.windAngle, amplitude: OCEAN_TUNING.simulation.amplitude }, u_noise: noise });
  const evolveSpectrum = gpu.effect(spectrumWgsl, { label: `${label}-spectrum` });
  evolveSpectrum.set({ u: { resolution, size: OCEAN_TUNING.simulation.oceanSize, time: 0, choppiness: OCEAN_TUNING.simulation.choppiness }, u_initialSpectrum: h0 });
  const targets: Record<SimulationTargetName, Target> = { spectrum, ping, pong };
  const ifft = createIfftStageTable().map((spec) => {
    const effect = gpu.effect(ifftStageWgsl, { label: `${label}-ifft-${spec.index}-${spec.horizontal ? 'h' : 'v'}` });
    effect.set({ u: { resolution, subtransformSize: spec.subtransformSize, horizontal: spec.horizontal ? 1 : 0 }, u_input: targets[spec.input] });
    return { spec, effect, output: targets[spec.output] };
  });
  const displacement = targets[ifft.at(-1)!.spec.output];
  const normals = gpu.effect(normalFoamWgsl, { label: `${label}-normal-foam` });
  normals.set({ u: { resolution, worldSize: OCEAN_TUNING.simulation.worldSize, displacementScale: OCEAN_TUNING.simulation.displacementScale, choppiness: OCEAN_TUNING.simulation.choppiness, foamThreshold: OCEAN_TUNING.simulation.foamThreshold }, u_displacement: displacement });
  const particles = gpu.draw({
    shader: particlesWgsl,
    vertices: 6,
    instances: resolution * resolution,
    blend: { color: { src: 'src-alpha', dst: 'one' }, alpha: { src: 'one', dst: 'one' } },
    label: `${label}-particles`,
  });
  particles.set({ u_displacement: displacement, u_normalFoam: normalFoam });
  setParticleConstants(particles, output);
  const brightEffect = gpu.effect(bloomBrightWgsl, { label: `${label}-bloom-bright` });
  brightEffect.set({ uniforms: { luminosityThreshold: OCEAN_TUNING.bloom.threshold, smoothWidth: OCEAN_TUNING.bloom.smoothWidth }, tDiffuse: scene, linearSampler: sampler });
  let bloomInput = bright;
  const levels = sizes.map((size, index) => {
    const horizontal = gpu.target({ size, format: HDR_FORMAT, label: `${label}-bloom-h${index}` });
    const vertical = gpu.target({ size, format: HDR_FORMAT, label: `${label}-bloom-v${index}` });
    const kernelRadius = OCEAN_TUNING.bloom.kernelRadii[index]!;
    const horizontalEffect = makeBlur(gpu, `${label}-blur-h${index}`, bloomInput, horizontal, sampler, [1, 0], kernelRadius);
    const verticalEffect = makeBlur(gpu, `${label}-blur-v${index}`, horizontal, vertical, sampler, [0, 1], kernelRadius);
    bloomInput = vertical;
    return { horizontal, vertical, horizontalEffect, verticalEffect };
  });
  const compositeEffect = gpu.effect(bloomCompositeWgsl, { label: `${label}-bloom-composite` });
  compositeEffect.set({
    uniforms: { bloomStrength: OCEAN_TUNING.bloom.strength, bloomRadius: OCEAN_TUNING.bloom.radius, bloomFactors0: [1, 0.8, 0.6, 0.4], bloomFactors1: [0.2, 0, 0, 0] },
    blurTexture1: levels[0]!.vertical, blurTexture2: levels[1]!.vertical, blurTexture3: levels[2]!.vertical,
    blurTexture4: levels[3]!.vertical, blurTexture5: levels[4]!.vertical, linearSampler: sampler,
  });
  const present = gpu.effect(presentWgsl, { label: `${label}-present` });
  present.set({ sceneHDR: scene, bloomTexture: composite, linearSampler: sampler });
  const graph: OceanGraph = { noise, h0, spectrum, ping, pong, normalFoam, scene, bright, composite, levels, noiseEffect, initialSpectrum, evolveSpectrum, ifft, normals, particles, brightEffect, compositeEffect, present, needsInitialSpectrum: true };
  await prewarm(graph, output);
  return graph;
}

function makeBlur(gpu: Gpu, label: string, source: Target, target: Target, sampler: GPUSampler, direction: readonly [number, number], kernelRadius: number): Effect {
  const effect = gpu.effect(bloomBlurWgsl, { label });
  const c = gaussianCoefficients(kernelRadius);
  effect.set({ uniforms: { direction, invSize: target.texelSize, gaussianCoefficients0: c.slice(0, 4), gaussianCoefficients1: c.slice(4, 8), gaussianCoefficients2: c.slice(8, 12), gaussianCoefficients3: c.slice(12, 16), gaussianCoefficients4: c.slice(16, 20), gaussianCoefficients5: c.slice(20, 24) }, colorTexture: source, linearSampler: sampler });
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

function setDynamics(g: OceanGraph, timeSeconds: number): void {
  g.evolveSpectrum.set({ u: { time: timeSeconds * OCEAN_TUNING.simulation.spectrumTimeScale } });
}
function setParticleConstants(draw: Draw, output: Output): void {
  const resolution = OCEAN_RESOLUTION;
  const camera = oceanCamera(output.size);
  const particles = OCEAN_TUNING.particles;
  const simulation = OCEAN_TUNING.simulation;
  draw.set({ u: {
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
function renderAt(gpu: Gpu, graph: OceanGraph, output: Target, time: number): void { setDynamics(graph, time); gpu.frame((frame) => renderGraph(frame, graph, output)); }
function renderGraph(frame: Frame, g: OceanGraph, output: Output): void {
  if (g.needsInitialSpectrum) {
    frame.pass({ target: g.noise, clear: TRANSPARENT }, (p) => p.draw(g.noiseEffect));
    frame.pass({ target: g.h0, clear: TRANSPARENT }, (p) => p.draw(g.initialSpectrum));
    g.needsInitialSpectrum = false;
  }
  frame.pass({ target: g.spectrum, clear: TRANSPARENT }, (p) => p.draw(g.evolveSpectrum));
  for (const stage of g.ifft) frame.pass({ target: stage.output, clear: TRANSPARENT }, (p) => p.draw(stage.effect));
  frame.pass({ target: g.normalFoam, clear: TRANSPARENT }, (p) => p.draw(g.normals));
  frame.pass({ target: g.scene, clear: TRANSPARENT }, (p) => p.draw(g.particles));
  frame.pass({ target: g.bright, clear: TRANSPARENT }, (p) => p.draw(g.brightEffect));
  for (const level of g.levels) {
    frame.pass({ target: level.horizontal, clear: TRANSPARENT }, (p) => p.draw(level.horizontalEffect));
    frame.pass({ target: level.vertical, clear: TRANSPARENT }, (p) => p.draw(level.verticalEffect));
  }
  frame.pass({ target: g.composite, clear: TRANSPARENT }, (p) => p.draw(g.compositeEffect));
  frame.pass({ target: output, clear: TRANSPARENT }, (p) => p.draw(g.present));
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
function destroyGraph(g: OceanGraph): void { for (const target of [g.noise, g.h0, g.spectrum, g.ping, g.pong, g.normalFoam, g.scene, g.bright, g.composite, ...g.levels.flatMap((x) => [x.horizontal, x.vertical])]) target.color.destroy(); }
