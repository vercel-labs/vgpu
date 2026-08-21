import type { Effect, Frame, Gpu, Surface, Target } from 'vgpu';
import { effect, sampler, target } from 'vgpu';

import blurWgsl from './blur.wgsl';
import brightPassWgsl from './bright-pass.wgsl';
import compositeWgsl from './composite.wgsl';
import fractalWgsl from './fractal.wgsl';
import type { Orbit } from './pointer-input';

type Output = Surface | Target;
export interface FractalEffects {
  scene: Effect;
  brightPass: Effect;
  blurH: Effect;
  blurV: Effect;
  composite: Effect;
  sampler: GPUSampler;
}
export interface FractalTargets {
  scene: Target;
  bloomA: Target;
  bloomB: Target;
}
const HDR_FORMAT: GPUTextureFormat = 'rgba16float';
const BLOOM_HEIGHT = 360;
const CLEAR: readonly [number, number, number, number] = [0, 0, 0, 1];
export const POSTER: Readonly<Orbit> = { yaw: 0.58, pitch: 0.24 };

export function createEffects(gpu: Gpu, label: string): FractalEffects {
  return {
    scene: effect(gpu, fractalWgsl, { label: `${label}-scene` }),
    brightPass: effect(gpu, brightPassWgsl, { label: `${label}-bright-pass` }),
    blurH: effect(gpu, blurWgsl, { label: `${label}-blur-h` }),
    blurV: effect(gpu, blurWgsl, { label: `${label}-blur-v` }),
    composite: effect(gpu, compositeWgsl, { label: `${label}-composite` }),
    sampler: sampler(gpu, { minFilter: 'linear', magFilter: 'linear' }),
  };
}
export function createTargets(
  gpu: Gpu,
  size: readonly [number, number],
  label: string
): FractalTargets {
  const full = normalizeSize(size),
    bloom = bloomSize(full);
  let scene: Target | undefined;
  let bloomA: Target | undefined;
  let bloomB: Target | undefined;
  try {
    scene = target(gpu, { size: full, format: HDR_FORMAT, label: `${label}-scene` });
    bloomA = target(gpu, { size: bloom, format: HDR_FORMAT, label: `${label}-bloom-a` });
    bloomB = target(gpu, { size: bloom, format: HDR_FORMAT, label: `${label}-bloom-b` });
    return { scene, bloomA, bloomB };
  } catch (error) {
    scene?.color.destroy();
    bloomA?.color.destroy();
    bloomB?.color.destroy();
    throw error;
  }
}
export function setConstants(e: FractalEffects): void {
  e.scene.set({ params: { resolution: [1, 1], ...POSTER } });
  e.brightPass.set({ samp: e.sampler, bright: { threshold: 1, knee: 0.25 } });
  e.blurH.set({ samp: e.sampler, blur: { direction: [1, 0], radius: 1.6 } });
  e.blurV.set({ samp: e.sampler, blur: { direction: [0, 1], radius: 1.6 } });
  e.composite.set({ samp: e.sampler, composite: { exposure: 1.05, bloomStrength: 0.65 } });
}
export function setBindings(e: FractalEffects, t: FractalTargets): void {
  e.scene.set({ params: { resolution: t.scene.size } });
  e.brightPass.set({ src: t.scene });
  e.blurH.set({ src: t.bloomA, blur: { texelSize: t.bloomA.texelSize } });
  e.blurV.set({ src: t.bloomB, blur: { texelSize: t.bloomB.texelSize } });
  e.composite.set({ scene: t.scene, bloom: t.bloomA });
}
export async function prewarm(e: FractalEffects, t: FractalTargets, output: Output): Promise<void> {
  await Promise.all([
    e.scene.compile(t.scene),
    e.brightPass.compile(t.bloomA),
    e.blurH.compile(t.bloomB),
    e.blurV.compile(t.bloomA),
    e.composite.compile({ colors: [output.format] }),
  ]);
}
export function renderChain(
  currentFrame: Frame,
  e: FractalEffects,
  t: FractalTargets,
  output: Output
): void {
  currentFrame.pass({ target: t.scene, clear: CLEAR }, (pass) => pass.draw(e.scene));
  currentFrame.pass({ target: t.bloomA, clear: CLEAR }, (pass) => pass.draw(e.brightPass));
  currentFrame.pass({ target: t.bloomB, clear: CLEAR }, (pass) => pass.draw(e.blurH));
  currentFrame.pass({ target: t.bloomA, clear: CLEAR }, (pass) => pass.draw(e.blurV));
  currentFrame.pass({ target: output, clear: CLEAR }, (pass) => pass.draw(e.composite));
}
export function resizeTargets(t: FractalTargets, size: readonly [number, number]): void {
  const full = normalizeSize(size),
    bloom = bloomSize(full);
  t.scene.resize(full);
  t.bloomA.resize(bloom);
  t.bloomB.resize(bloom);
}
function normalizeSize(size: readonly [number, number]): [number, number] {
  return [Math.max(1, Math.floor(size[0])), Math.max(1, Math.floor(size[1]))];
}
function bloomSize(size: readonly [number, number]): [number, number] {
  const height = Math.max(1, Math.min(BLOOM_HEIGHT, size[1]));
  return [Math.max(1, Math.round((height * size[0]) / size[1])), height];
}
export function destroyTargets(t: FractalTargets): void {
  t.scene.color.destroy();
  t.bloomA.color.destroy();
  t.bloomB.color.destroy();
}
