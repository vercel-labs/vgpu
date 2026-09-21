import { frame, type Gpu, type Target } from 'vgpu';

import {
  createEffects,
  createTargets,
  destroyTargets,
  prewarm,
  renderChain,
  setBindings,
} from './pipeline';

type ThumbOptions = {
  time?: number;
  onVariantRendered?(
    variant: 'time-delta' | 'pointer-orbit',
    pixels: Uint8Array,
    size: readonly [number, number],
  ): void | Promise<void>;
};

export async function renderThumbnail(
  gpu: Gpu,
  colorTarget: Target,
  opts: ThumbOptions = {},
): Promise<void> {
  const targets = createTargets(gpu, colorTarget.size);
  try {
    const effects = createEffects(gpu, targets);
    const time = opts.time ?? 8.5;
    setBindings(effects, targets);
    await prewarm(effects, targets, colorTarget);
    const render = (at: number, pointer: readonly [number, number]) => {
      effects.scene.set({ params: { pointer, time: at } });
      frame(gpu, (current) => renderChain(current, effects, targets, colorTarget));
    };
    render(time + 7, [0, 0.05]);
    await gpu.gpu.queue.onSubmittedWorkDone();
    await opts.onVariantRendered?.(
      'time-delta',
      await colorTarget.color.read({ mipLevel: 0, region: "all" }),
      colorTarget.size,
    );
    render(time, [0.72, 0.34]);
    await gpu.gpu.queue.onSubmittedWorkDone();
    await opts.onVariantRendered?.(
      'pointer-orbit',
      await colorTarget.color.read({ mipLevel: 0, region: "all" }),
      colorTarget.size,
    );
    render(time, [0, 0.05]);
  } finally {
    await Promise.allSettled([
      Promise.resolve().then(() => gpu.gpu.queue.onSubmittedWorkDone()),
      Promise.resolve().then(() => gpu.settled()),
    ]);
    destroyTargets(targets);
  }
}
