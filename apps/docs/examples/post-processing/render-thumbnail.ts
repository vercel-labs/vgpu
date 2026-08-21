import type { Gpu, Target } from 'vgpu';
import { frame } from 'vgpu';

import type { ThumbnailOptions } from '../../lib/example-renderer';
import {
  createEffects,
  createTargets,
  destroyEffects,
  destroyTargets,
  prewarm,
  renderChain,
  setChainBindings,
  setChainConstants,
  setGradeFlags,
  type ChainTargets,
  type EffectChain,
} from './pipeline';
import { DEFAULT_POST_PROCESSING_CONTROLS, type PostProcessingControls } from './types';

type PostProcessingMode = 'all-off' | 'bloom-only' | 'ca-only';
interface ThumbOptions extends ThumbnailOptions {
  onModeRendered?: (
    mode: PostProcessingMode,
    pixels: Uint8Array,
    size: readonly [number, number]
  ) => void | Promise<void>;
}
const THUMB_MODES: readonly [PostProcessingMode, PostProcessingControls][] = [
  ['all-off', { bloom: false, ca: false }],
  ['bloom-only', { bloom: true, ca: false }],
  ['ca-only', { bloom: false, ca: true }],
];

export async function renderThumbnail(
  gpu: Gpu,
  colorTarget: Target,
  opts: ThumbOptions = {}
): Promise<void> {
  let effects: EffectChain | undefined;
  let targets: ChainTargets | undefined;
  try {
    effects = createEffects(gpu, 'post-processing-thumb');
    targets = createTargets(gpu, colorTarget.size, 'post-processing-thumb');
    await prewarm(effects, targets, colorTarget);
    setChainConstants(effects);
    setChainBindings(effects, targets, colorTarget);
    const dt = opts.dt ?? 1 / 60;
    let time = opts.time ?? 2;
    for (const [mode, flags] of THUMB_MODES) {
      setGradeFlags(effects.grade, flags);
      frame(gpu, (currentFrame) =>
        renderChain(currentFrame, effects!, targets!, colorTarget, time)
      );
      await gpu.gpu.queue.onSubmittedWorkDone();
      await opts.onModeRendered?.(mode, await colorTarget.read(), colorTarget.size);
    }
    setGradeFlags(effects.grade, DEFAULT_POST_PROCESSING_CONTROLS);
    for (let i = 0; i < Math.max(1, opts.warmupFrames ?? 60); i++) {
      time += dt;
      frame(gpu, (currentFrame) =>
        renderChain(currentFrame, effects!, targets!, colorTarget, time)
      );
    }
  } finally {
    await Promise.allSettled([gpu.gpu.queue.onSubmittedWorkDone(), gpu.settled()]);
    if (targets) destroyTargets(targets);
    if (effects) destroyEffects(effects);
  }
}
