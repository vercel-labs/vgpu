import type { Effect, Frame, Gpu, Surface, Target } from 'vgpu';
import { effect, frame, sampler, target } from 'vgpu';

import blackHoleWgsl from './black-hole.wgsl';
import blurWgsl from './blur.wgsl';
import brightPassWgsl from './bright-pass.wgsl';
import compositeWgsl from './composite.wgsl';

type Output = Surface | Target;
export type Orbit = readonly [number, number];
export interface BlackHoleEffects {
  scene: Effect;
  brightPass: Effect;
  blurH1: Effect;
  blurV1: Effect;
  blurH2: Effect;
  blurV2: Effect;
  composite: Effect;
  sampler: GPUSampler;
}
export interface BlackHoleTargets {
  scene: Target;
  bloomA: Target;
  bloomB: Target;
}
const HDR_FORMAT: GPUTextureFormat = 'rgba16float';
const BLOOM_HEIGHT = 360;
const CLEAR: readonly [number, number, number, number] = [0, 0, 0, 1];

export function createEffects(gpu: Gpu, label: string): BlackHoleEffects {
  return {
    scene: effect(gpu, blackHoleWgsl, { label: `${label}-scene` }),
    brightPass: effect(gpu, brightPassWgsl, { label: `${label}-bright-pass` }),
    blurH1: effect(gpu, blurWgsl, { label: `${label}-blur-h1` }),
    blurV1: effect(gpu, blurWgsl, { label: `${label}-blur-v1` }),
    blurH2: effect(gpu, blurWgsl, { label: `${label}-blur-h2` }),
    blurV2: effect(gpu, blurWgsl, { label: `${label}-blur-v2` }),
    composite: effect(gpu, compositeWgsl, { label: `${label}-composite` }),
    sampler: sampler(gpu, { minFilter: 'linear', magFilter: 'linear' }),
  };
}
export function createTargets(
  gpu: Gpu,
  size: readonly [number, number],
  label: string
): BlackHoleTargets {
  const full = normalizeSize(size);
  const bloom = bloomSize(full);
  let scene: Target | undefined;
  let bloomA: Target | undefined;
  try {
    scene = target(gpu, { size: full, format: HDR_FORMAT, label: `${label}-scene` });
    bloomA = target(gpu, { size: bloom, format: HDR_FORMAT, label: `${label}-bloom-a` });
    const bloomB = target(gpu, { size: bloom, format: HDR_FORMAT, label: `${label}-bloom-b` });
    return { scene, bloomA, bloomB };
  } catch (error) {
    destroyTarget(bloomA);
    destroyTarget(scene);
    throw error;
  }
}
export function destroyTargets(targets: BlackHoleTargets): void {
  destroyTarget(targets.bloomB);
  destroyTarget(targets.bloomA);
  destroyTarget(targets.scene);
}
function destroyTarget(colorTarget: Target | undefined): void {
  (colorTarget as { destroy?: () => void } | undefined)?.destroy?.();
}
export function setConstants(effects: BlackHoleEffects): void {
  effects.scene.set({ params: { pointer: [0, 0.05], time: 0, motion: 1 } });
  effects.brightPass.set({ samp: effects.sampler, bright: { threshold: 1, knee: 0.6 } });
  effects.blurH1.set({ samp: effects.sampler, blur: { direction: [1, 0], radius: 1 } });
  effects.blurV1.set({ samp: effects.sampler, blur: { direction: [0, 1], radius: 1 } });
  effects.blurH2.set({ samp: effects.sampler, blur: { direction: [1, 0], radius: 2.4 } });
  effects.blurV2.set({ samp: effects.sampler, blur: { direction: [0, 1], radius: 2.4 } });
  effects.composite.set({
    samp: effects.sampler,
    composite: { exposure: 1.15, bloomStrength: 0.9 },
  });
}
export function setBindings(
  effects: BlackHoleEffects,
  targets: BlackHoleTargets,
  output: Output
): void {
  effects.scene.set({ params: { resolution: targets.scene.size } });
  effects.brightPass.set({ src: targets.scene });
  effects.blurH1.set({ src: targets.bloomA, blur: { texelSize: targets.bloomA.texelSize } });
  effects.blurV1.set({ src: targets.bloomB, blur: { texelSize: targets.bloomB.texelSize } });
  effects.blurH2.set({ src: targets.bloomA, blur: { texelSize: targets.bloomA.texelSize } });
  effects.blurV2.set({ src: targets.bloomB, blur: { texelSize: targets.bloomB.texelSize } });
  effects.composite.set({ scene: targets.scene, bloom: targets.bloomA });
  void output;
}
export async function prewarm(
  effects: BlackHoleEffects,
  targets: BlackHoleTargets,
  output: Output
): Promise<void> {
  await Promise.all([
    effects.scene.compile(targets.scene),
    effects.brightPass.compile(targets.bloomA),
    effects.blurH1.compile(targets.bloomB),
    effects.blurV1.compile(targets.bloomA),
    effects.blurH2.compile(targets.bloomB),
    effects.blurV2.compile(targets.bloomA),
    effects.composite.compile({ colors: [output.format] }),
  ]);
}
export function renderChain(
  currentFrame: Frame,
  effects: BlackHoleEffects,
  targets: BlackHoleTargets,
  output: Output
): void {
  currentFrame.pass({ target: targets.scene, clear: CLEAR }, (pass) => pass.draw(effects.scene));
  currentFrame.pass({ target: targets.bloomA, clear: CLEAR }, (pass) =>
    pass.draw(effects.brightPass)
  );
  currentFrame.pass({ target: targets.bloomB, clear: CLEAR }, (pass) => pass.draw(effects.blurH1));
  currentFrame.pass({ target: targets.bloomA, clear: CLEAR }, (pass) => pass.draw(effects.blurV1));
  currentFrame.pass({ target: targets.bloomB, clear: CLEAR }, (pass) => pass.draw(effects.blurH2));
  currentFrame.pass({ target: targets.bloomA, clear: CLEAR }, (pass) => pass.draw(effects.blurV2));
  currentFrame.pass({ target: output, clear: CLEAR }, (pass) => pass.draw(effects.composite));
}
export function renderAt(
  gpu: Gpu,
  effects: BlackHoleEffects,
  targets: BlackHoleTargets,
  output: Target,
  time: number,
  pointer: Orbit
): void {
  effects.scene.set({ params: { pointer, time } });
  frame(gpu, (currentFrame) => renderChain(currentFrame, effects, targets, output));
}
function normalizeSize(size: readonly [number, number]): [number, number] {
  return [Math.max(1, Math.floor(size[0])), Math.max(1, Math.floor(size[1]))];
}
function bloomSize(size: readonly [number, number]): [number, number] {
  const height = Math.max(1, Math.min(BLOOM_HEIGHT, size[1]));
  return [Math.max(1, Math.round((height * size[0]) / size[1])), height];
}
