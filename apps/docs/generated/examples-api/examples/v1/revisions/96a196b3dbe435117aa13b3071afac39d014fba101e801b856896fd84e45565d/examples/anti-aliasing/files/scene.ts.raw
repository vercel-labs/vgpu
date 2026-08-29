import {
  draw,
  effect,
  geometry,
  target,
  type Frame,
  type Gpu,
  type Surface,
  type Target,
} from 'vgpu';

import fxaaWgsl from './fxaa.wgsl';
import resolveWgsl from './resolve.wgsl';
import sceneWgsl from './scene.wgsl';

export const MODES = { Off: 0, 'MSAA 4×': 1, 'SSAA 2×': 2, FXAA: 3 } as const;
export type AaMode = (typeof MODES)[keyof typeof MODES];
export const ALL_MODES = Object.values(MODES) as AaMode[];
export const DEFAULT_MODE: AaMode = MODES.FXAA;

type Output = Surface | Target;

export function createScene(gpu: Gpu, output: Output) {
  const vertices = createSpokeVertices();
  const mesh = geometry(gpu, {
    buffers: [
      {
        data: vertices.buffer as ArrayBuffer,
        stride: 12,
        attributes: { local_position: 'float32x2', accent: 'float32' },
      },
    ],
  });
  const owned: Target[] = [];

  try {
    const scene = draw(gpu, { shader: sceneWgsl, geometry: mesh });
    const resolve = effect(gpu, resolveWgsl);
    const fxaa = effect(gpu, fxaaWgsl);
    const [width, height] = output.size;
    const makeTarget = (options: Parameters<typeof target>[1]) => {
      const value = target(gpu, options);
      owned.push(value);
      return value;
    };
    const msaa = makeTarget({ size: [width, height], msaa: true });
    const ssaa = makeTarget({ size: [width * 2, height * 2] });
    const ldr = makeTarget({ size: [width, height] });
    let boundMode: AaMode | undefined;

    fxaa.set({ scene_tex: ldr });
    scene.set({ logical_resolution: output.size });

    const prewarm = () =>
      Promise.all([
        scene.compile({ colors: [output.format] }),
        scene.compile(msaa),
        scene.compile(ssaa),
        scene.compile(ldr),
        resolve.compile({ colors: [output.format] }),
        fxaa.compile({ colors: [output.format] }),
      ]).then(() => undefined);
    const resize = (size: readonly [number, number]) => {
      const [nextWidth, nextHeight] = size;
      msaa.resize([nextWidth, nextHeight]);
      ssaa.resize([nextWidth * 2, nextHeight * 2]);
      ldr.resize([nextWidth, nextHeight]);
      scene.set({ logical_resolution: size });
    };
    const render = (currentFrame: Frame, mode: AaMode, time: number) => {
      if (mode !== boundMode) {
        boundMode = mode;
        if (mode === MODES['MSAA 4×']) {
          resolve.set({ kind: 0, scene_tex: msaa });
        } else if (mode === MODES['SSAA 2×']) {
          resolve.set({ kind: 1, scene_tex: ssaa });
        }
      }

      scene.set({ time });
      if (mode === MODES.Off) {
        currentFrame.pass({ target: output }, (pass) => pass.draw(scene));
      } else if (mode === MODES['MSAA 4×'] || mode === MODES['SSAA 2×']) {
        const source = mode === MODES['MSAA 4×'] ? msaa : ssaa;
        currentFrame.pass({ target: source }, (pass) => pass.draw(scene));
        currentFrame.pass({ target: output }, (pass) => pass.draw(resolve));
      } else {
        currentFrame.pass({ target: ldr }, (pass) => pass.draw(scene));
        currentFrame.pass({ target: output }, (pass) => pass.draw(fxaa));
      }
    };
    const destroy = () => {
      for (const colorTarget of owned) destroyTarget(colorTarget);
      mesh.destroy();
    };

    return { prewarm, resize, render, destroy };
  } catch (error) {
    for (const colorTarget of owned) destroyTarget(colorTarget);
    mesh.destroy();
    throw error;
  }
}

function createSpokeVertices(): Float32Array {
  const data: number[] = [];
  const spokeCount = 44;

  for (let i = 0; i < spokeCount; i++) {
    const angle = (i / spokeCount) * Math.PI * 2;
    const x = Math.cos(angle);
    const y = Math.sin(angle);
    const nx = -y;
    const ny = x;
    const inner = i % 4 === 0 ? 0.06 : 0.13;
    const outer = i % 5 === 0 ? 0.88 : 0.72 + (i % 3) * 0.055;
    const halfWidth = i % 5 === 0 ? 0.009 : 0.0045;
    const accent = (i % 7) / 6;
    const a = [x * inner + nx * halfWidth, y * inner + ny * halfWidth];
    const b = [x * inner - nx * halfWidth, y * inner - ny * halfWidth];
    const c = [x * outer - nx * halfWidth, y * outer - ny * halfWidth];
    const d = [x * outer + nx * halfWidth, y * outer + ny * halfWidth];
    data.push(...a, accent, ...b, accent, ...c, accent, ...a, accent, ...c, accent, ...d, accent);
  }

  return new Float32Array(data);
}

function destroyTarget(colorTarget: Target) {
  (colorTarget as Target & { destroy?: () => void }).destroy?.();
}
