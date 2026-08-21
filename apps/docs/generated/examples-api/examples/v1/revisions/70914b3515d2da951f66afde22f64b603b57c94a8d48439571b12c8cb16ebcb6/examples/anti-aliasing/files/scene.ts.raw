import type { Draw, Effect, Frame, Gpu, Surface, Target } from 'vgpu';
import { draw, effect, sampler, target } from 'vgpu';

import fxaaWgsl from './fxaa.wgsl';
import resolveWgsl from './resolve.wgsl';
import sceneWgsl from './scene.wgsl';
import { AA_MODE_FXAA, AA_MODE_MSAA_4X, AA_MODE_OFF, AA_MODE_SSAA_2X, type AaMode } from './types';

export interface AaEffects {
  readonly scene: Draw;
  readonly vertexBuffer: GPUBuffer;
  readonly resolve: Effect;
  readonly fxaa: Effect;
  readonly sampler: GPUSampler;
}
export interface AaTargets {
  readonly msaa: Target;
  readonly ssaa: Target;
  readonly ldr: Target;
}

const FORMAT: GPUTextureFormat = 'rgba8unorm';
const CLEAR_BLACK: readonly [number, number, number, number] = [0, 0, 0, 1];
export const ALL_MODES: readonly AaMode[] = [
  AA_MODE_OFF,
  AA_MODE_MSAA_4X,
  AA_MODE_SSAA_2X,
  AA_MODE_FXAA,
];
export const isMode = (value: number): value is AaMode => ALL_MODES.includes(value as AaMode);

export function createEffects(gpu: Gpu, label: string): AaEffects {
  const vertices = createSpokeVertices();
  const buffer = gpu.device.createBuffer({
    size: vertices.byteLength,
    usage: ['vertex', 'copy_dst'],
    label: `${label}-geometry`,
  });
  try {
    buffer.write(vertices.buffer as ArrayBuffer);
    return {
      scene: draw(gpu, {
        shader: sceneWgsl,
        label: `${label}-scene`,
        geometry: {
          vertexBuffers: [buffer.gpu],
          vertexBufferLayouts: [
            {
              arrayStride: 12,
              attributes: [
                { shaderLocation: 0, offset: 0, format: 'float32x2' },
                { shaderLocation: 1, offset: 8, format: 'float32' },
              ],
            },
          ],
          vertexCount: vertices.length / 3,
        },
      }),
      vertexBuffer: buffer.gpu,
      resolve: effect(gpu, resolveWgsl, { label: `${label}-resolve` }),
      fxaa: effect(gpu, fxaaWgsl, { label: `${label}-fxaa` }),
      sampler: sampler(gpu, {
        minFilter: 'linear',
        magFilter: 'linear',
        addressModeU: 'clamp-to-edge',
        addressModeV: 'clamp-to-edge',
      }),
    };
  } catch (error) {
    buffer.gpu.destroy();
    throw error;
  }
}

export function createTargets(gpu: Gpu, size: readonly [number, number], label: string): AaTargets {
  const [width, height] = normalizedSize(size);
  const created: Target[] = [];
  try {
    const msaa = target(gpu, {
      size: [width, height],
      format: FORMAT,
      msaa: true,
      label: `${label}-msaa-4x`,
    });
    created.push(msaa);
    const ssaa = target(gpu, {
      size: [width * 2, height * 2],
      format: FORMAT,
      label: `${label}-ssaa-2x`,
    });
    created.push(ssaa);
    const ldr = target(gpu, { size: [width, height], format: FORMAT, label: `${label}-fxaa-ldr` });
    created.push(ldr);
    return { msaa, ssaa, ldr };
  } catch (error) {
    for (const colorTarget of created)
      (colorTarget as Target & { destroy?: () => void }).destroy?.();
    throw error;
  }
}

export function resizeTargets(targets: AaTargets, size: readonly [number, number]): void {
  const [width, height] = normalizedSize(size);
  targets.msaa.resize([width, height]);
  targets.ssaa.resize([width * 2, height * 2]);
  targets.ldr.resize([width, height]);
}
export async function prewarm(
  effects: AaEffects,
  targets: AaTargets,
  output: Surface | Target
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
export function setStaticBindings(effects: AaEffects, targets: AaTargets): void {
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
export function setResolutionBindings(effects: AaEffects, output: Surface | Target): void {
  effects.scene.set({ logical_resolution: output.size, _pad: 0 });
  effects.resolve.set({ resolution: output.size, _pad: 0 });
  effects.fxaa.set({ resolution: output.size });
}
export function setModeBindings(effects: AaEffects, targets: AaTargets, mode: AaMode): void {
  if (mode === AA_MODE_MSAA_4X) effects.resolve.set({ kind: 0, scene_tex: targets.msaa });
  else if (mode === AA_MODE_SSAA_2X) effects.resolve.set({ kind: 1, scene_tex: targets.ssaa });
}

export function renderMode(
  currentFrame: Frame,
  effects: AaEffects,
  targets: AaTargets,
  output: Surface | Target,
  mode: AaMode,
  time: number
): void {
  effects.scene.set({ time });
  if (mode === AA_MODE_OFF) {
    currentFrame.pass({ target: output, clear: CLEAR_BLACK }, (pass) => pass.draw(effects.scene));
    return;
  }
  if (mode === AA_MODE_MSAA_4X) {
    currentFrame.pass({ target: targets.msaa, clear: CLEAR_BLACK }, (pass) =>
      pass.draw(effects.scene)
    );
    currentFrame.pass({ target: output, clear: CLEAR_BLACK }, (pass) => pass.draw(effects.resolve));
    return;
  }
  if (mode === AA_MODE_SSAA_2X) {
    currentFrame.pass({ target: targets.ssaa, clear: CLEAR_BLACK }, (pass) =>
      pass.draw(effects.scene)
    );
    currentFrame.pass({ target: output, clear: CLEAR_BLACK }, (pass) => pass.draw(effects.resolve));
    return;
  }
  currentFrame.pass({ target: targets.ldr, clear: CLEAR_BLACK }, (pass) =>
    pass.draw(effects.scene)
  );
  currentFrame.pass({ target: output, clear: CLEAR_BLACK }, (pass) => pass.draw(effects.fxaa));
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
    const a: readonly [number, number] = [
      direction[0] * inner + normal[0] * halfWidth,
      direction[1] * inner + normal[1] * halfWidth,
    ];
    const b: readonly [number, number] = [
      direction[0] * inner - normal[0] * halfWidth,
      direction[1] * inner - normal[1] * halfWidth,
    ];
    const c: readonly [number, number] = [
      direction[0] * outer - normal[0] * halfWidth,
      direction[1] * outer - normal[1] * halfWidth,
    ];
    const d: readonly [number, number] = [
      direction[0] * outer + normal[0] * halfWidth,
      direction[1] * outer + normal[1] * halfWidth,
    ];
    for (const point of [a, b, c, a, c, d]) data.push(point[0], point[1], accent);
  }
  return new Float32Array(data);
}
function normalizedSize(size: readonly [number, number]): [number, number] {
  return [Math.max(1, Math.floor(size[0])), Math.max(1, Math.floor(size[1]))];
}
export function destroyEffects(effects: AaEffects): void {
  effects.vertexBuffer.destroy();
}
export function destroyTargets(targets: AaTargets): void {
  for (const colorTarget of [targets.msaa, targets.ssaa, targets.ldr])
    (colorTarget as Target & { destroy?: () => void }).destroy?.();
}
