import type { Effect, Gpu, Surface, Target } from 'vgpu';

import {
  atlasSizeFor,
  cascadeCountForSize,
  jfaJumps,
  RC_INTERVAL0,
  RC_OVERLAP,
  strokeRadiance,
  type Vec2,
} from './math';
import type { PaintSegment } from './pointer-input';
import { resolveView, type RadianceView } from './types';
import paintEmitterWgsl from './paint-emitter.wgsl';
import jfaInitWgsl from './jfa-init.wgsl';
import jfaPassWgsl from './jfa-pass.wgsl';
import sdfFinalizeWgsl from './sdf-finalize.wgsl';
import radianceCascadeWgsl from './radiance-cascade.wgsl';
import presentWgsl from './present.wgsl';
import { effect, frame, sampler, target } from "vgpu";

type Output = Surface | Target;

/**
 * Linear HDR everywhere upstream of `present`.
 *
 * rgba8 would band the falloff and clip the emitters long before the merge; the research
 * lists it as one of the optimisations that quietly destroys the technique.
 */
const HDR_FORMAT: GPUTextureFormat = 'rgba16float';
/**
 * Jump-flood seeds hold absolute pixel coordinates.
 *
 * f16 cannot represent every integer past 2048, and a seed rounded by one texel becomes a
 * distance field wrong by one texel, which sphere tracing turns into visible leaks. The
 * seeds are only ever `textureLoad`ed, so the format never needs filtering.
 */
const SEED_FORMAT: GPUTextureFormat = 'rgba32float';

/** Grid: ~1px darker rules every 48 physical pixels. Low contrast on purpose. */
const GRID_CELL = 48;
const GRID_LINE_WIDTH = 1;
const GRID_BASE_ALBEDO = 0.38;
const GRID_LINE_ALBEDO = 0.21;
/** Keeps unlit corners from being pure black without washing out the shadows. */
const AMBIENT = 0.01;
/** Below 1 so the lit grid keeps the colour of the light instead of clipping to white. */
const EXPOSURE = 0.85;
/** Stroke half-width in physical pixels. */
const STROKE_RADIUS = 5;
/** Triangle apex distance, as a fraction of the smaller canvas side. */
const TRIANGLE_SCALE = 0.11;
/** One band of the SDF debug ramp. */
const SDF_DEBUG_PERIOD = 64;

export interface RadianceScene {
  readonly gpu: Gpu;
  readonly label: string;
  /** Emitter / SDF resolution, in physical pixels: exactly the surface. */
  readonly size: Vec2;
  /** Shared cascade atlas size; identical for every level. */
  readonly atlas: Vec2;
  readonly cascadeCount: number;
  readonly jumps: readonly number[];
  /** Ping-pong: `emitter[0]` always holds the current emitters. */
  emitter: [Target, Target];
  jfa: [Target, Target];
  readonly sdf: Target;
  /** Two recycled atlases; `cascades[0]` holds the most recently written level. */
  cascades: [Target, Target];
  readonly effects: {
    readonly paint: Effect;
    readonly jfaInit: Effect;
    readonly jfaSteps: readonly Effect[];
    readonly sdfFinalize: Effect;
    readonly cascade: readonly Effect[];
    readonly present: Effect;
  };
  readonly sampler: GPUSampler;
  /** Increments on every painted stroke; drives the emitter palette. */
  strokes: number;
  /** Lowest cascade the last chain run computed. */
  resolvedTo: number;
}

export function createScene(gpu: Gpu, size: Vec2, label: string): RadianceScene {
  const width = Math.max(1, Math.floor(size[0]));
  const height = Math.max(1, Math.floor(size[1]));
  const cascadeCount = cascadeCountForSize(width, height);
  const { atlas } = atlasSizeFor(width, height, cascadeCount);
  const jumps = jfaJumps(Math.max(width, height));
  const created: Target[] = [];

  try {
    const scene: Vec2 = [width, height];
    const emitter: [Target, Target] = [
      target(gpu, { size: [width, height], format: HDR_FORMAT, label: `${label}-emitter-a` }),
      target(gpu, { size: [width, height], format: HDR_FORMAT, label: `${label}-emitter-b` }),
    ];
    created.push(...emitter);
    const jfa: [Target, Target] = [
      target(gpu, { size: [width, height], format: SEED_FORMAT, label: `${label}-jfa-a` }),
      target(gpu, { size: [width, height], format: SEED_FORMAT, label: `${label}-jfa-b` }),
    ];
    created.push(...jfa);
    const sdf = target(gpu, { size: [width, height], format: HDR_FORMAT, label: `${label}-sdf` });
    created.push(sdf);
    // Two atlases, reused from the top of the hierarchy down; six resident levels would
    // cost six times the memory for exactly the same result.
    const cascades: [Target, Target] = [
      target(gpu, { size: [atlas[0], atlas[1]], format: HDR_FORMAT, label: `${label}-cascade-a` }),
      target(gpu, { size: [atlas[0], atlas[1]], format: HDR_FORMAT, label: `${label}-cascade-b` }),
    ];
    created.push(...cascades);

    return {
      gpu,
      label,
      size: scene,
      atlas,
      cascadeCount,
      jumps,
      emitter,
      jfa,
      sdf,
      cascades,
      effects: {
        paint: effect(gpu, paintEmitterWgsl, { label: `${label}-paint` }),
        jfaInit: effect(gpu, jfaInitWgsl, { label: `${label}-jfa-init` }),
        // One effect instance per pass: `set()` writes immediately, so passes sharing an
        // instance inside a frame would all run with the last jump distance written.
        jfaSteps: jumps.map((_, index) => effect(gpu, jfaPassWgsl, { label: `${label}-jfa-${index}` })),
        sdfFinalize: effect(gpu, sdfFinalizeWgsl, { label: `${label}-sdf-finalize` }),
        cascade: Array.from({ length: cascadeCount }, (_, index) =>
          effect(gpu, radianceCascadeWgsl, { label: `${label}-cascade-${index}` })),
        present: effect(gpu, presentWgsl, { label: `${label}-present` }),
      },
      sampler: sampler(gpu, {
        minFilter: 'linear',
        magFilter: 'linear',
        // Screen space: a ray leaving the canvas must not wrap around to the other side.
        addressModeU: 'clamp-to-edge',
        addressModeV: 'clamp-to-edge',
      }),
      strokes: 0,
      resolvedTo: 0,
    };
  } catch (error) {
    for (const colorTarget of created) destroyTarget(colorTarget);
    throw error;
  }
}

/** Compiles every pipeline against the formats it will actually render into. */
export async function prepareScene(scene: RadianceScene, outputFormat: GPUTextureFormat): Promise<void> {
  await Promise.all([
    scene.effects.paint.compile({ colors: [HDR_FORMAT] }),
    scene.effects.jfaInit.compile({ colors: [SEED_FORMAT] }),
    ...scene.effects.jfaSteps.map((shader) => shader.compile({ colors: [SEED_FORMAT] })),
    scene.effects.sdfFinalize.compile({ colors: [HDR_FORMAT] }),
    ...scene.effects.cascade.map((shader) => shader.compile({ colors: [HDR_FORMAT] })),
    scene.effects.present.compile({ colors: [outputFormat] }),
  ]);
}

export function destroyScene(scene: RadianceScene): void {
  for (const colorTarget of [...scene.emitter, ...scene.jfa, scene.sdf, ...scene.cascades]) destroyTarget(colorTarget);
}

function destroyTarget(colorTarget: Target): void {
  (colorTarget as Target & { destroy?: () => void }).destroy?.();
}

export interface ChainOptions {
  /** Segment to paint this run; omitted while the pointer is idle. */
  readonly segment?: PaintSegment;
  /** False resets the canvas to the triangle alone. */
  readonly keepPrevious?: boolean;
  /** Which view the present pass will show; decides how deep the descent has to go. */
  readonly view?: RadianceView;
}

interface ChainPass {
  readonly name: string;
  readonly target: Target;
  readonly effect: Effect;
}

/**
 * Binds and orders the whole dirty chain, without submitting it.
 *
 * Returning the passes instead of encoding them lets the live renderer submit all of them
 * in one frame, and the debug harness submit them one at a time so every intermediate can
 * be read back — the same bindings and the same order either way.
 */
function buildChain(scene: RadianceScene, options: ChainOptions): ChainPass[] {
  const { size, atlas, effects } = scene;
  const stopAt = resolveView(options.view ?? 'final', scene.cascadeCount).stopAt;
  const keepPrevious = options.keepPrevious ?? true;
  const segment = options.segment;
  if (segment) scene.strokes = Math.max(scene.strokes, segment.stroke);

  const passes: ChainPass[] = [];

  // 1. Emitters. Ping-pong because a pass cannot sample the target it draws into.
  const [emitterRead, emitterWrite] = scene.emitter;
  effects.paint.set({
    paint: {
      size: [size[0], size[1]],
      stroke_from: segment ? [segment.from[0] * size[0], segment.from[1] * size[1]] : [0, 0],
      stroke_to: segment ? [segment.to[0] * size[0], segment.to[1] * size[1]] : [0, 0],
      radius: STROKE_RADIUS,
      keep_previous: keepPrevious ? 1 : 0,
      color: strokeRadiance(segment?.stroke ?? 0),
      stroke_active: segment ? 1 : 0,
      triangle_centre: [size[0] * 0.5, size[1] * 0.5],
      triangle_radius: Math.min(size[0], size[1]) * TRIANGLE_SCALE,
      _pad: 0,
    },
    previous: emitterRead,
  });
  passes.push({ name: 'emitters', target: emitterWrite, effect: effects.paint });
  scene.emitter = [emitterWrite, emitterRead];

  // 2. Jump flood: seed from the emitter mask, then halve the jump until it reaches 1.
  effects.jfaInit.set({ jfa: { size: [size[0], size[1]], threshold: 0.5, _pad: 0 }, emitter: emitterWrite });
  passes.push({ name: 'jfa-init', target: scene.jfa[0], effect: effects.jfaInit });

  let seedRead = scene.jfa[0];
  let seedWrite = scene.jfa[1];
  scene.jumps.forEach((jump, index) => {
    const shader = effects.jfaSteps[index]!;
    shader.set({ jfa: { size: [size[0], size[1]], jump, _pad: 0 }, seeds: seedRead });
    passes.push({ name: `jfa-step-${index}-jump-${jump}`, target: seedWrite, effect: shader });
    const previous = seedRead;
    seedRead = seedWrite;
    seedWrite = previous;
  });
  scene.jfa = [seedRead, seedWrite];

  // 3. Seeds become distances, in pixels.
  effects.sdfFinalize.set({
    sdf: { size: [size[0], size[1]], far: Math.hypot(size[0], size[1]) * 2, encode_scale: 1 },
    seeds: seedRead,
  });
  passes.push({ name: 'sdf', target: scene.sdf, effect: effects.sdfFinalize });

  // 4. Cascades, top-down: each level traces its own interval and merges the level above.
  let atlasWrite = scene.cascades[0];
  let atlasRead = scene.cascades[1];
  for (let cascade = scene.cascadeCount - 1; cascade >= stopAt; cascade--) {
    const shader = effects.cascade[cascade]!;
    const hasUpper = cascade < scene.cascadeCount - 1;
    shader.set({
      rc: {
        atlas_size: [atlas[0], atlas[1]],
        scene_size: [size[0], size[1]],
        cascade,
        interval0: RC_INTERVAL0,
        overlap: RC_OVERLAP,
        sdf_scale: 1,
        has_upper: hasUpper ? 1 : 0,
        _pad0: 0,
        _pad1: 0,
        _pad2: 0,
      },
      sdf_tex: scene.sdf,
      sdf_samp: scene.sampler,
      emitter_tex: emitterWrite,
      emitter_samp: scene.sampler,
      // The top level has nothing above it; the binding still has to point somewhere.
      upper_tex: atlasRead,
    });
    passes.push({ name: `cascade-${cascade}`, target: atlasWrite, effect: shader });
    const previous = atlasRead;
    atlasRead = atlasWrite;
    atlasWrite = previous;
  }
  scene.cascades = [atlasRead, atlasWrite];
  scene.resolvedTo = stopAt;

  return passes;
}

/** The live path: paint, flood, trace and merge, all in one submit. */
export function runChain(scene: RadianceScene, options: ChainOptions = {}): void {
  const passes = buildChain(scene, options);
  frame(scene.gpu, (currentFrame) => {
    for (const pass of passes) {
      currentFrame.pass({ target: pass.target, clear: [0, 0, 0, 0] }, (encoder) => encoder.draw(pass.effect));
    }
  });
}

/**
 * The debug path: the same passes, one submit each, with a hook after every one.
 *
 * Splitting the submits is what makes the intermediates readable — the live renderer never
 * takes this route.
 */
export async function runChainStaged(
  scene: RadianceScene,
  options: ChainOptions,
  onStage: (name: string, colorTarget: Target) => Promise<void> | void,
): Promise<void> {
  for (const pass of buildChain(scene, options)) {
    frame(scene.gpu, (currentFrame) => {
      currentFrame.pass({ target: pass.target, clear: [0, 0, 0, 0] }, (encoder) => encoder.draw(pass.effect));
    });
    await scene.gpu.gpu.queue.onSubmittedWorkDone();
    await onStage(pass.name, pass.target);
  }
}

/** Presents the cached radiance. Cheap: no tracing happens here. */
export function presentScene(scene: RadianceScene, output: Output, view: RadianceView): void {
  const resolved = resolveView(view, scene.cascadeCount);
  scene.effects.present.set({
    present: {
      size: [output.size[0], output.size[1]],
      atlas_size: [scene.atlas[0], scene.atlas[1]],
      exposure: EXPOSURE,
      view: resolved.mode,
      sdf_period: SDF_DEBUG_PERIOD,
      grid_cell: GRID_CELL,
      grid_line_width: GRID_LINE_WIDTH,
      grid_base: GRID_BASE_ALBEDO,
      grid_line: GRID_LINE_ALBEDO,
      ambient: AMBIENT,
    },
    cascade_tex: scene.cascades[0],
    emitter_tex: scene.emitter[0],
    sdf_tex: scene.sdf,
  });
  frame(scene.gpu, (currentFrame) => {
    currentFrame.pass({ target: output, clear: [0, 0, 0, 1] }, (encoder) => encoder.draw(scene.effects.present));
  });
}

export { HDR_FORMAT, SEED_FORMAT, STROKE_RADIUS, TRIANGLE_SCALE };
