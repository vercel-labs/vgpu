import {
  effect,
  sampler,
  target,
  type Frame,
  type Gpu,
  type Surface,
  type Target,
} from 'vgpu';

import blackHoleWgsl from './black-hole.wgsl';
import blurWgsl from './blur.wgsl';
import brightPassWgsl from './bright-pass.wgsl';
import compositeWgsl from './composite.wgsl';

type Output = Surface | Target;
export type Orbit = readonly [number, number];
const CLEAR = [0, 0, 0, 1] as const;
const BLURS = [
  { direction: [1, 0], radius: 1 },
  { direction: [0, 1], radius: 1 },
  { direction: [1, 0], radius: 2.4 },
  { direction: [0, 1], radius: 2.4 },
] as const;

export function createEffects(gpu: Gpu) {
  const samp = sampler(gpu, { minFilter: 'linear', magFilter: 'linear' });
  return {
    scene: effect(gpu, blackHoleWgsl, { set: { params: { pointer: [0, 0.05], time: 0 } } }),
    bright: effect(gpu, brightPassWgsl, { set: { samp } }),
    blur: BLURS.map((blur) => effect(gpu, blurWgsl, { set: { samp, blur } })),
    composite: effect(gpu, compositeWgsl, { set: { samp } }),
  };
}

type Effects = ReturnType<typeof createEffects>;

export function createTargets(gpu: Gpu, size: readonly [number, number]) {
  const height = Math.min(360, size[1]);
  const bloom: [number, number] = [Math.max(1, Math.round(height * size[0] / size[1])), height];
  let scene: Target | undefined;
  let bloomA: Target | undefined;
  try {
    scene = target(gpu, { size, format: 'rgba16float' });
    bloomA = target(gpu, { size: bloom, format: 'rgba16float' });
    return {
      scene,
      bloom: [bloomA, target(gpu, { size: bloom, format: 'rgba16float' })] as const,
    };
  } catch (error) {
    destroy(bloomA);
    destroy(scene);
    throw error;
  }
}

type Targets = ReturnType<typeof createTargets>;

export function destroyTargets(targets: Targets): void {
  destroy(targets.bloom[1]);
  destroy(targets.bloom[0]);
  destroy(targets.scene);
}

function destroy(color: Target | undefined): void {
  (color as { destroy?: () => void } | undefined)?.destroy?.();
}

export function setBindings(effects: Effects, targets: Targets): void {
  effects.scene.set({ params: { resolution: targets.scene.size } });
  effects.bright.set({ src: targets.scene });
  effects.blur.forEach((blur, i) =>
    blur.set({
      src: targets.bloom[i % 2],
      blur: { texelSize: targets.bloom[i % 2].texelSize },
    }),
  );
  effects.composite.set({ scene: targets.scene, bloom: targets.bloom[0] });
}

export async function prewarm(effects: Effects, targets: Targets, output: Output): Promise<void> {
  await Promise.all([
    effects.scene.compile(targets.scene),
    effects.bright.compile(targets.bloom[0]),
    ...effects.blur.map((blur, i) => blur.compile(targets.bloom[(i + 1) % 2])),
    effects.composite.compile({ colors: [output.format] }),
  ]);
}

export function renderChain(frame: Frame, effects: Effects, targets: Targets, output: Output): void {
  frame.pass({ target: targets.scene, clear: CLEAR }, (pass) => pass.draw(effects.scene));
  frame.pass({ target: targets.bloom[0], clear: CLEAR }, (pass) => pass.draw(effects.bright));
  effects.blur.forEach((blur, i) => {
    frame.pass({ target: targets.bloom[(i + 1) % 2], clear: CLEAR }, (pass) =>
      pass.draw(blur),
    );
  });
  frame.pass({ target: output, clear: CLEAR }, (pass) => pass.draw(effects.composite));
}
