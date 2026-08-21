import type { Effect, Gpu, Surface, Target } from 'vgpu';
import { effect, frame, sampler, target } from 'vgpu';

import agentDotsWgsl from './agent-dots.wgsl';
import jfaInitWgsl from './jfa-init.wgsl';
import jfaPassWgsl from './jfa-pass.wgsl';
import radianceCascadeWgsl from './radiance-cascade.wgsl';
import sdfFinalizeWgsl from './sdf-finalize.wgsl';
import presentWgsl from './present.wgsl';
import { atlasSizeFor, cascadeCountForSize, jfaJumps, RC_INTERVAL0, RC_OVERLAP, type Vec2 } from './math';
import {
  AGENT_RADIANCE_ANIMATION_MODES,
  resolveView,
  type AgentRadianceAnimation,
  type AgentRadianceView,
} from './types';

type Output = Surface | Target;

const HDR_FORMAT: GPUTextureFormat = 'rgba16float';
const SEED_FORMAT: GPUTextureFormat = 'rgba32float';
const DOT_SPACING = 0.105;
const DOT_RADIUS = 0.0295;
const BASE_RADIANCE = 0.065;
const PEAK_RADIANCE = 8.5;
const EXPOSURE = 0.92;
const BACKDROP_ALBEDO = 0.075;
const AMBIENT = 0.004;
const SDF_DEBUG_PERIOD = 48;

export interface AgentRadianceScene {
  readonly gpu: Gpu;
  readonly label: string;
  readonly size: Vec2;
  readonly atlas: Vec2;
  readonly directionBase: number;
  readonly cascadeCount: number;
  readonly jumps: readonly number[];
  readonly emitter: Target;
  jfa: [Target, Target];
  readonly sdf: Target;
  cascades: [Target, Target];
  readonly effects: {
    readonly dots: Effect;
    readonly jfaInit: Effect;
    readonly jfaSteps: readonly Effect[];
    readonly sdfFinalize: Effect;
    readonly cascade: readonly Effect[];
    readonly present: Effect;
  };
  readonly sampler: GPUSampler;
}

export function createScene(gpu: Gpu, size: Vec2, label: string, directionBase = 2): AgentRadianceScene {
  const width = Math.max(1, Math.floor(size[0]));
  const height = Math.max(1, Math.floor(size[1]));
  const cascadeCount = cascadeCountForSize(width, height);
  const atlas = atlasSizeFor(width, height, cascadeCount, directionBase);
  const jumps = jfaJumps(Math.max(width, height));
  const created: Target[] = [];

  try {
    const emitter = target(gpu, { size: [width, height], format: HDR_FORMAT, label: `${label}-emitters` });
    created.push(emitter);
    const jfa: [Target, Target] = [
      target(gpu, { size: [width, height], format: SEED_FORMAT, label: `${label}-jfa-a` }),
      target(gpu, { size: [width, height], format: SEED_FORMAT, label: `${label}-jfa-b` }),
    ];
    created.push(...jfa);
    const sdf = target(gpu, { size: [width, height], format: HDR_FORMAT, label: `${label}-sdf` });
    created.push(sdf);
    const cascades: [Target, Target] = [
      target(gpu, { size: [atlas[0], atlas[1]], format: HDR_FORMAT, label: `${label}-cascade-a` }),
      target(gpu, { size: [atlas[0], atlas[1]], format: HDR_FORMAT, label: `${label}-cascade-b` }),
    ];
    created.push(...cascades);

    return {
      gpu,
      label,
      size: [width, height],
      atlas,
      directionBase,
      cascadeCount,
      jumps,
      emitter,
      jfa,
      sdf,
      cascades,
      effects: {
        dots: effect(gpu, agentDotsWgsl, { label: `${label}-dots` }),
        jfaInit: effect(gpu, jfaInitWgsl, { label: `${label}-jfa-init` }),
        jfaSteps: jumps.map((_, index) => effect(gpu, jfaPassWgsl, { label: `${label}-jfa-${index}` })),
        sdfFinalize: effect(gpu, sdfFinalizeWgsl, { label: `${label}-sdf-finalize` }),
        cascade: Array.from({ length: cascadeCount }, (_, index) =>
          effect(gpu, radianceCascadeWgsl, { label: `${label}-cascade-${index}` })),
        present: effect(gpu, presentWgsl, { label: `${label}-present` }),
      },
      sampler: sampler(gpu, {
        minFilter: 'linear',
        magFilter: 'linear',
        addressModeU: 'clamp-to-edge',
        addressModeV: 'clamp-to-edge',
      }),
    };
  } catch (error) {
    for (const colorTarget of created) destroyTarget(colorTarget);
    throw error;
  }
}

export async function prepareScene(scene: AgentRadianceScene, outputFormat: GPUTextureFormat): Promise<void> {
  await Promise.all([
    scene.effects.dots.compile({ colors: [HDR_FORMAT] }),
    scene.effects.jfaInit.compile({ colors: [SEED_FORMAT] }),
    ...scene.effects.jfaSteps.map((shader) => shader.compile({ colors: [SEED_FORMAT] })),
    scene.effects.sdfFinalize.compile({ colors: [HDR_FORMAT] }),
    ...scene.effects.cascade.map((shader) => shader.compile({ colors: [HDR_FORMAT] })),
    scene.effects.present.compile({ colors: [outputFormat] }),
  ]);
}

export function destroyScene(scene: AgentRadianceScene): void {
  for (const colorTarget of [scene.emitter, ...scene.jfa, scene.sdf, ...scene.cascades]) destroyTarget(colorTarget);
}

function destroyTarget(colorTarget: Target): void {
  (colorTarget as Target & { destroy?: () => void }).destroy?.();
}

interface ChainPass {
  readonly target: Target;
  readonly effect: Effect;
}

function buildChain(
  scene: AgentRadianceScene,
  time: number,
  view: AgentRadianceView,
  animation: AgentRadianceAnimation,
): ChainPass[] {
  const { size, atlas, effects } = scene;
  const resolved = resolveView(view, scene.cascadeCount);
  const scale = Math.min(size[0], size[1]);
  const passes: ChainPass[] = [];

  effects.dots.set({
    agent: {
      size: [size[0], size[1]],
      time,
      spacing: scale * DOT_SPACING,
      radius: scale * DOT_RADIUS,
      base_radiance: BASE_RADIANCE,
      peak_radiance: PEAK_RADIANCE,
      edge_softness: 0.8,
      animation_mode: AGENT_RADIANCE_ANIMATION_MODES[animation],
    },
  });
  passes.push({ target: scene.emitter, effect: effects.dots });
  if (!resolved.needsJfa) return passes;

  effects.jfaInit.set({ jfa: { size: [size[0], size[1]], threshold: 0.5, _pad: 0 }, emitter: scene.emitter });
  passes.push({ target: scene.jfa[0], effect: effects.jfaInit });

  let seedRead = scene.jfa[0];
  let seedWrite = scene.jfa[1];
  scene.jumps.forEach((jump, index) => {
    const shader = effects.jfaSteps[index]!;
    shader.set({ jfa: { size: [size[0], size[1]], jump, _pad: 0 }, seeds: seedRead });
    passes.push({ target: seedWrite, effect: shader });
    [seedRead, seedWrite] = [seedWrite, seedRead];
  });
  scene.jfa = [seedRead, seedWrite];
  if (!resolved.needsSdf) return passes;

  effects.sdfFinalize.set({
    sdf: { size: [size[0], size[1]], far: Math.hypot(size[0], size[1]) * 2, encode_scale: 1 },
    seeds: seedRead,
  });
  passes.push({ target: scene.sdf, effect: effects.sdfFinalize });

  let atlasWrite = scene.cascades[0];
  let atlasRead = scene.cascades[1];
  for (let cascade = scene.cascadeCount - 1; cascade >= resolved.stopAt; cascade--) {
    const shader = effects.cascade[cascade]!;
    shader.set({
      rc: {
        atlas_size: [atlas[0], atlas[1]],
        scene_size: [size[0], size[1]],
        cascade,
        interval0: RC_INTERVAL0,
        overlap: RC_OVERLAP,
        sdf_scale: 1,
        has_upper: cascade < scene.cascadeCount - 1 ? 1 : 0,
        direction_base: scene.directionBase,
        _pad1: 0,
        _pad2: 0,
      },
      sdf_tex: scene.sdf,
      sdf_samp: scene.sampler,
      emitter_tex: scene.emitter,
      emitter_samp: scene.sampler,
      upper_tex: atlasRead,
    });
    passes.push({ target: atlasWrite, effect: shader });
    [atlasRead, atlasWrite] = [atlasWrite, atlasRead];
  }
  scene.cascades = [atlasRead, atlasWrite];
  return passes;
}

export function renderLighting(
  scene: AgentRadianceScene,
  time: number,
  view: AgentRadianceView,
  animation: AgentRadianceAnimation = 'center-out',
): void {
  const passes = buildChain(scene, time, view, animation);
  frame(scene.gpu, (currentFrame) => {
    for (const pass of passes) {
      currentFrame.pass({ target: pass.target, clear: [0, 0, 0, 0] }, (encoder) => encoder.draw(pass.effect));
    }
  });
}

export function presentScene(scene: AgentRadianceScene, output: Output, view: AgentRadianceView): void {
  scene.effects.present.set({
    present: {
      scene_size: [scene.size[0], scene.size[1]],
      atlas_size: [scene.atlas[0], scene.atlas[1]],
      exposure: EXPOSURE,
      view: resolveView(view, scene.cascadeCount).mode,
      sdf_period: SDF_DEBUG_PERIOD,
      albedo: BACKDROP_ALBEDO,
      ambient: AMBIENT,
      direction_base: scene.directionBase,
    },
    cascade_tex: scene.cascades[0],
    emitter_tex: scene.emitter,
    sdf_tex: scene.sdf,
    jfa_tex: scene.jfa[0],
    emitter_samp: scene.sampler,
  });
  frame(scene.gpu, (currentFrame) => {
    currentFrame.pass({ target: output, clear: [0, 0, 0, 1] }, (encoder) => encoder.draw(scene.effects.present));
  });
}

export { HDR_FORMAT };
