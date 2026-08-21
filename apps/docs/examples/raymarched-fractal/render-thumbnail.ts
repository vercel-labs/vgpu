import type { Gpu, Target } from 'vgpu';
import { frame } from 'vgpu';

import type { ThumbnailOptions } from '../../lib/example-renderer';
import type { Orbit } from './pointer-input';
import {
  createEffects,
  createTargets,
  destroyTargets,
  POSTER,
  prewarm,
  renderChain,
  setBindings,
  setConstants,
  type FractalEffects,
  type FractalTargets,
} from './pipeline';

type Variant = 'static-repeat' | 'alternate-orbit' | 'bloom-off';
interface ThumbOptions extends ThumbnailOptions {
  onVariantRendered?: (
    variant: Variant,
    pixels: Uint8Array,
    size: readonly [number, number]
  ) => void | Promise<void>;
}
const ALTERNATE: Readonly<Orbit> = { yaw: -0.35, pitch: 0.1 };

export async function renderThumbnail(
  gpu: Gpu,
  colorTarget: Target,
  opts: ThumbOptions = {}
): Promise<void> {
  const effects = createEffects(gpu, 'raymarched-fractal-thumb');
  const targets = createTargets(gpu, colorTarget.size, 'raymarched-fractal-thumb');
  setConstants(effects);
  setBindings(effects, targets);
  try {
    await prewarm(effects, targets, colorTarget);
    await renderAndWait(gpu, effects, targets, colorTarget, POSTER);
    await renderAndWait(gpu, effects, targets, colorTarget, POSTER);
    await reportVariant(opts, 'static-repeat', colorTarget);
    await renderAndWait(gpu, effects, targets, colorTarget, ALTERNATE);
    await reportVariant(opts, 'alternate-orbit', colorTarget);
    effects.composite.set({ composite: { bloomStrength: 0 } });
    await renderAndWait(gpu, effects, targets, colorTarget, POSTER);
    await reportVariant(opts, 'bloom-off', colorTarget);
    effects.composite.set({ composite: { bloomStrength: 0.65 } });
    await renderAndWait(gpu, effects, targets, colorTarget, POSTER);
    await gpu.settled();
  } finally {
    try {
      await gpu.gpu.queue.onSubmittedWorkDone();
    } finally {
      destroyTargets(targets);
    }
  }
}
async function reportVariant(
  opts: ThumbOptions,
  variant: Variant,
  colorTarget: Target
): Promise<void> {
  if (!opts.onVariantRendered) return;
  const pixels = await colorTarget.read();
  await opts.onVariantRendered(variant, new Uint8Array(pixels), colorTarget.size);
}
async function renderAndWait(
  gpu: Gpu,
  effects: FractalEffects,
  targets: FractalTargets,
  output: Target,
  orbit: Readonly<Orbit>
) {
  effects.scene.set({ params: orbit });
  frame(gpu, (currentFrame) => renderChain(currentFrame, effects, targets, output));
  await gpu.gpu.queue.onSubmittedWorkDone();
}
