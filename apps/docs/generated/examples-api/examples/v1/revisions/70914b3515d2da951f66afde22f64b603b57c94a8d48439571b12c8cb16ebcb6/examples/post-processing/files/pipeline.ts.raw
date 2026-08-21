import type { Draw, Effect, Frame, Gpu, Surface, Target } from 'vgpu';
import { draw, effect, sampler, target } from 'vgpu';

import blurWgsl from './blur.wgsl';
import gradeWgsl from './grade.wgsl';
import sceneWgsl from './scene.wgsl';
import thresholdWgsl from './threshold.wgsl';
import type { PostProcessingControls } from './types';

export interface EffectChain {
  scene: Draw;
  sceneVertexBuffer: GPUBuffer;
  threshold: Effect;
  blurH: Effect;
  blurV: Effect;
  grade: Effect;
  sampler: GPUSampler;
}
export interface ChainTargets {
  scene: Target;
  bright: Target;
  blurA: Target;
  blurB: Target;
}
const FORMAT: GPUTextureFormat = 'rgba8unorm';
const SCENE_CLEAR: readonly [number, number, number, number] = [0.004, 0.006, 0.014, 1];

export function createEffects(gpu: Gpu, label: string): EffectChain {
  const vertices = createSceneVertices();
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
              arrayStride: 24,
              attributes: [
                { shaderLocation: 0, offset: 0, format: 'float32x2' },
                { shaderLocation: 1, offset: 8, format: 'float32x3' },
                { shaderLocation: 2, offset: 20, format: 'float32' },
              ],
            },
          ],
          vertexCount: vertices.length / 6,
        },
      }),
      sceneVertexBuffer: buffer.gpu,
      threshold: effect(gpu, thresholdWgsl, { label: `${label}-threshold` }),
      blurH: effect(gpu, blurWgsl, { label: `${label}-blur-h` }),
      blurV: effect(gpu, blurWgsl, { label: `${label}-blur-v` }),
      grade: effect(gpu, gradeWgsl, { label: `${label}-grade` }),
      sampler: sampler(gpu, { minFilter: 'linear', magFilter: 'linear' }),
    };
  } catch (error) {
    buffer.gpu.destroy();
    throw error;
  }
}

export function createTargets(
  gpu: Gpu,
  size: readonly [number, number],
  label: string
): ChainTargets {
  const full = normalizeSize(size);
  const half = halfSize(full);
  const created: Target[] = [];
  try {
    const scene = target(gpu, { size: full, format: FORMAT, label: `${label}-scene` });
    created.push(scene);
    const bright = target(gpu, { size: half, format: FORMAT, label: `${label}-bright` });
    created.push(bright);
    const blurA = target(gpu, { size: half, format: FORMAT, label: `${label}-blur-a` });
    created.push(blurA);
    const blurB = target(gpu, { size: half, format: FORMAT, label: `${label}-blur-b` });
    created.push(blurB);
    return { scene, bright, blurA, blurB };
  } catch (error) {
    for (const colorTarget of created)
      (colorTarget as Target & { destroy?: () => void }).destroy?.();
    throw error;
  }
}

export async function prewarm(
  effects: EffectChain,
  targets: ChainTargets,
  output: Surface | Target
): Promise<void> {
  await Promise.all([
    effects.scene.compile(targets.scene),
    effects.threshold.compile(targets.bright),
    effects.blurH.compile(targets.blurA),
    effects.blurV.compile(targets.blurB),
    effects.grade.compile({ colors: [output.format] }),
  ]);
}
export function setChainConstants(effects: EffectChain): void {
  effects.scene.set({ _pad: 0 });
  effects.threshold.set({ threshold: 0.82, knee: 0.045, linear_samp: effects.sampler });
  effects.blurH.set({ direction: [1, 0], linear_samp: effects.sampler });
  effects.blurV.set({ direction: [0, 1], linear_samp: effects.sampler });
  effects.grade.set({
    linear_samp: effects.sampler,
    bloomStrength: 1.85,
    caAmount: 0.052,
    _pad0: 0,
    _pad1: 0,
  });
}
export function setChainBindings(
  effects: EffectChain,
  targets: ChainTargets,
  output: Surface | Target
): void {
  const sceneSize = targets.scene.size;
  const blurSize = targets.blurA.size;
  effects.scene.set({ resolution: sceneSize });
  effects.threshold.set({ resolution: blurSize, scene_tex: targets.scene });
  effects.blurH.set({ resolution: blurSize, source_tex: targets.bright });
  effects.blurV.set({ resolution: blurSize, source_tex: targets.blurA });
  effects.grade.set({
    resolution: output.size,
    scene_tex: targets.scene,
    bloom_tex: targets.blurB,
  });
}
export function setGradeFlags(grade: Effect, flags: PostProcessingControls): void {
  grade.set({ bloomOn: flags.bloom ? 1 : 0, caOn: flags.ca ? 1 : 0 });
}

export function renderChain(
  currentFrame: Frame,
  effects: EffectChain,
  targets: ChainTargets,
  output: Surface | Target,
  time: number
): void {
  effects.scene.set({ time });
  currentFrame.pass({ target: targets.scene, clear: SCENE_CLEAR }, (pass) =>
    pass.draw(effects.scene)
  );
  currentFrame.pass({ target: targets.bright, clear: [0, 0, 0, 1] }, (pass) =>
    pass.draw(effects.threshold)
  );
  currentFrame.pass({ target: targets.blurA, clear: [0, 0, 0, 1] }, (pass) =>
    pass.draw(effects.blurH)
  );
  currentFrame.pass({ target: targets.blurB, clear: [0, 0, 0, 1] }, (pass) =>
    pass.draw(effects.blurV)
  );
  currentFrame.pass({ target: output, clear: [0, 0, 0, 1] }, (pass) => pass.draw(effects.grade));
}

function createSceneVertices(): Float32Array {
  const data: number[] = [];
  const addVertex = (
    point: readonly [number, number],
    color: readonly [number, number, number],
    phase: number
  ) => {
    data.push(point[0], point[1], color[0], color[1], color[2], phase);
  };
  const addQuad = (
    points: readonly [
      readonly [number, number],
      readonly [number, number],
      readonly [number, number],
      readonly [number, number]
    ],
    color: readonly [number, number, number],
    phase: number
  ) => {
    for (const index of [0, 1, 2, 0, 2, 3]) addVertex(points[index], color, phase);
  };
  const corners = (cx: number, cy: number, width: number, height: number, angle: number) => {
    const c = Math.cos(angle),
      s = Math.sin(angle);
    return (
      [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ] as const
    ).map(([x, y]) => {
      const px = x * width * 0.5,
        py = y * height * 0.5;
      return [cx + px * c - py * s, cy + px * s + py * c] as const;
    }) as unknown as readonly [
      readonly [number, number],
      readonly [number, number],
      readonly [number, number],
      readonly [number, number]
    ];
  };
  const addRect = (
    cx: number,
    cy: number,
    width: number,
    height: number,
    angle: number,
    color: readonly [number, number, number],
    phase: number
  ) => addQuad(corners(cx, cy, width, height, angle), color, phase);
  const addFrame = (
    cx: number,
    cy: number,
    width: number,
    height: number,
    thickness: number,
    angle: number,
    color: readonly [number, number, number],
    phase: number
  ) => {
    addRect(cx, cy - height * 0.5, width, thickness, angle, color, phase);
    addRect(cx, cy + height * 0.5, width, thickness, angle, color, phase);
    addRect(cx - width * 0.5, cy, thickness, height, angle, color, phase);
    addRect(cx + width * 0.5, cy, thickness, height, angle, color, phase);
  };
  addFrame(0, 0, 2.82, 1.42, 0.018, 0, [0.15, 0.48, 0.62], 0.1);
  addFrame(0, 0, 2.3, 1.05, 0.014, 0, [0.48, 0.16, 0.4], 0.24);
  addFrame(0, 0, 1.45, 0.7, 0.01, 0, [0.55, 0.47, 0.22], 0.38);
  addRect(-1.22, 0.2, 0.34, 0.23, -0.18, [0.48, 0.56, 0.62], 0.52);
  addRect(1.24, -0.2, 0.38, 0.25, 0.16, [0.54, 0.46, 0.58], 0.64);
  addRect(-0.72, -0.36, 0.42, 0.045, -0.32, [0.62, 0.32, 0.26], 0.74);
  addRect(0.72, 0.36, 0.42, 0.045, -0.32, [0.25, 0.52, 0.64], 0.82);
  addRect(0, 0, 0.018, 0.56, 0, [0.58, 0.58, 0.61], 0.9);
  addRect(0, 0, 0.56, 0.018, 0, [0.58, 0.58, 0.61], 0.9);
  addRect(-1.25, -0.48, 0.07, 0.07, Math.PI / 4, [1.0, 0.96, 0.9], 0.14);
  addRect(1.27, 0.47, 0.064, 0.064, Math.PI / 4, [0.9, 1.0, 1.0], 0.31);
  addRect(-0.78, 0.33, 0.055, 0.055, Math.PI / 4, [1.0, 0.91, 0.98], 0.48);
  addRect(0.83, -0.35, 0.058, 0.058, Math.PI / 4, [0.96, 1.0, 0.86], 0.67);
  addRect(0.03, 0.02, 0.046, 0.046, Math.PI / 4, [1.0, 1.0, 1.0], 0.87);
  return new Float32Array(data);
}
function normalizeSize(size: readonly [number, number]): readonly [number, number] {
  return [Math.max(1, Math.floor(size[0])), Math.max(1, Math.floor(size[1]))];
}
function halfSize(size: readonly [number, number]): readonly [number, number] {
  return [Math.max(1, Math.ceil(size[0] / 2)), Math.max(1, Math.ceil(size[1] / 2))];
}
export function destroyEffects(effects: EffectChain): void {
  effects.sceneVertexBuffer.destroy();
}
export function destroyTargets(targets: ChainTargets): void {
  for (const colorTarget of [targets.scene, targets.bright, targets.blurA, targets.blurB])
    (colorTarget as Target & { destroy?: () => void }).destroy?.();
}
