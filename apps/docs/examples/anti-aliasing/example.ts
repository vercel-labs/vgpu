import type { Draw, Effect, Frame, Gpu, Surface, Target } from 'vgpu';
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
  onModeRendered?: (mode: AaMode, pixels: Uint8Array, size: readonly [number, number]) => void | Promise<void>;
}

interface AaEffects {
  readonly scene: Draw;
  readonly vertexBuffer: GPUBuffer;
  readonly resolve: Effect;
  readonly fxaa: Effect;
  readonly sampler: GPUSampler;
}

interface AaTargets {
  readonly msaa: Target;
  readonly ssaa: Target;
  readonly ldr: Target;
}

const FORMAT: GPUTextureFormat = 'rgba8unorm';
const CLEAR_BLACK: readonly [number, number, number, number] = [0, 0, 0, 1];
const ALL_MODES: readonly AaMode[] = [AA_MODE_OFF, AA_MODE_MSAA_4X, AA_MODE_SSAA_2X, AA_MODE_FXAA];

export async function run(canvas: HTMLCanvasElement): Promise<() => void> {
  const { init } = await import('vgpu');
  const gpu = await init();
  const surface = gpu.surface(canvas, { dpr: [1, 2] });
  const effects = createEffects(gpu, 'anti-aliasing');
  const targets = createTargets(gpu, surface.size, 'anti-aliasing');
  const controls = installControls(canvas);
  let disposed = false;
  let sawInitialResize = false;

  // Compile every target signature before the frame loop so mode changes never compile lazily.
  await prewarm(effects, targets, surface);
  setStaticBindings(effects, targets);
  setResolutionBindings(effects, surface);
  let mode = controls.getMode();
  setModeBindings(effects, targets, mode);

  const unsubscribeResize = surface.onResize(() => {
    if (!sawInitialResize) {
      sawInitialResize = true;
      return;
    }
    if (disposed) return;
    resizeTargets(targets, surface.size);
    setResolutionBindings(effects, surface);
  });

  const handle = gpu.frame.loop((frame) => {
    const nextMode = controls.getMode();
    if (nextMode !== mode) {
      mode = nextMode;
      setModeBindings(effects, targets, mode);
    }
    renderMode(frame, effects, targets, surface, mode, gpu.time);
  });

  return () => {
    if (disposed) return;
    disposed = true;
    handle.stop();
    unsubscribeResize();
    controls.dispose();
    destroyEffects(effects);
    destroyTargets(targets);
    surface.dispose();
    gpu.dispose();
  };
}

export async function renderThumb(
  gpu: Gpu,
  target: Target,
  opts: ThumbOptions = {},
): Promise<void> {
  const effects = createEffects(gpu, 'anti-aliasing-thumb');
  const targets = createTargets(gpu, target.size, 'anti-aliasing-thumb');
  await prewarm(effects, targets, target);
  setStaticBindings(effects, targets);
  setResolutionBindings(effects, target);
  let configuredMode: AaMode | undefined;
  const configureMode = (mode: AaMode) => {
    if (mode === configuredMode) return;
    configuredMode = mode;
    setModeBindings(effects, targets, mode);
  };

  const dt = opts.dt ?? 1 / 60;
  let time = opts.time ?? 1.2;

  // The gallery normally ends on FXAA, but exercise every mode first so Docker validates
  // all lazily-selected pipelines (including the 4x sample-count variant) and bindings.
  for (const mode of ALL_MODES) {
    configureMode(mode);
    gpu.frame((frame) => renderMode(frame, effects, targets, target, mode, time));
    await gpu.gpu.queue.onSubmittedWorkDone();
    await opts.onModeRendered?.(mode, await target.read(), target.size);
  }

  const warmupFrames = Math.max(1, opts.warmupFrames ?? 60);
  for (let i = 0; i < warmupFrames; i++) {
    time += dt;
    configureMode(AA_MODE_FXAA);
    gpu.frame((frame) => renderMode(frame, effects, targets, target, AA_MODE_FXAA, time));
  }

  await gpu.gpu.queue.onSubmittedWorkDone();
  await gpu.settled();
  destroyEffects(effects);
  destroyTargets(targets);
}

function createEffects(gpu: Gpu, label: string): AaEffects {
  const vertices = createSpokeVertices();
  const buffer = gpu.device.createBuffer({
    size: vertices.byteLength,
    usage: ['vertex', 'copy_dst'],
    label: `${label}-geometry`,
  });
  buffer.write(vertices.buffer as ArrayBuffer);

  return {
    scene: gpu.draw({
      shader: sceneWgsl,
      label: `${label}-scene`,
      mesh: {
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
  };
}

function createTargets(gpu: Gpu, size: readonly [number, number], label: string): AaTargets {
  const [width, height] = normalizedSize(size);
  return {
    // Dawn compat in Docker rejects rgba16float+MSAA, so every AA intermediate is rgba8unorm.
    msaa: gpu.target({ size: [width, height], format: FORMAT, msaa: true, label: `${label}-msaa-4x` }),
    ssaa: gpu.target({ size: [width * 2, height * 2], format: FORMAT, label: `${label}-ssaa-2x` }),
    ldr: gpu.target({ size: [width, height], format: FORMAT, label: `${label}-fxaa-ldr` }),
  };
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
