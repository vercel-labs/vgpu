import type { Gpu, Target } from 'vgpu';

import type { ThumbnailOptions } from '../../lib/example-renderer';
import {
  createEffects,
  createTargets,
  destroyTargets,
  prewarm,
  renderAt,
  setBindings,
  setConstants,
} from './pipeline';

interface ThumbOptions extends ThumbnailOptions {
  onVariantRendered?: (
    variant: 'time-delta' | 'pointer-orbit',
    pixels: Uint8Array,
    size: readonly [number, number]
  ) => void | Promise<void>;
}

export async function renderThumbnail(
  gpu: Gpu,
  colorTarget: Target,
  opts: ThumbOptions = {}
): Promise<void> {
  const effects = createEffects(gpu, 'black-hole-thumb');
  const targets = createTargets(gpu, colorTarget.size, 'black-hole-thumb');
  try {
    const time = opts.time ?? 8.5;
    setConstants(effects);
    setBindings(effects, targets, colorTarget);
    await prewarm(effects, targets, colorTarget);
    renderAt(gpu, effects, targets, colorTarget, time, [0, 0.05]);
    await gpu.gpu.queue.onSubmittedWorkDone();
    renderAt(gpu, effects, targets, colorTarget, time + 7, [0, 0.05]);
    await gpu.gpu.queue.onSubmittedWorkDone();
    await opts.onVariantRendered?.('time-delta', await colorTarget.read(), colorTarget.size);
    renderAt(gpu, effects, targets, colorTarget, time, [0.72, 0.34]);
    await gpu.gpu.queue.onSubmittedWorkDone();
    await opts.onVariantRendered?.('pointer-orbit', await colorTarget.read(), colorTarget.size);
    renderAt(gpu, effects, targets, colorTarget, time, [0, 0.05]);
  } finally {
    await Promise.allSettled([
      Promise.resolve().then(() => gpu.gpu.queue.onSubmittedWorkDone()),
      Promise.resolve().then(() => gpu.settled()),
    ]);
    destroyTargets(targets);
  }
}
