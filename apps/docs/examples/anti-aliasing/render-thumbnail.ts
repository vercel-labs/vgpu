import type { Gpu, Target } from 'vgpu';
import { frame } from 'vgpu';

import type { ThumbnailOptions } from '../../lib/example-renderer';
import {
  ALL_MODES,
  createEffects,
  createTargets,
  destroyEffects,
  destroyTargets,
  prewarm,
  renderMode,
  setModeBindings,
  setResolutionBindings,
  setStaticBindings,
  type AaEffects,
  type AaTargets,
} from './scene';
import { DEFAULT_ANTI_ALIASING_CONTROLS, type AaMode } from './types';

interface ThumbOptions extends ThumbnailOptions {
  onModeRendered?: (
    mode: AaMode,
    pixels: Uint8Array,
    size: readonly [number, number]
  ) => void | Promise<void>;
}

export async function renderThumbnail(
  gpu: Gpu,
  colorTarget: Target,
  opts: ThumbOptions = {}
): Promise<void> {
  let effects: AaEffects | undefined;
  let targets: AaTargets | undefined;
  try {
    effects = createEffects(gpu, 'anti-aliasing-thumb');
    targets = createTargets(gpu, colorTarget.size, 'anti-aliasing-thumb');
    await prewarm(effects, targets, colorTarget);
    setStaticBindings(effects, targets);
    setResolutionBindings(effects, colorTarget);
    let configuredMode: AaMode | undefined;
    const configureMode = (mode: AaMode) => {
      if (mode !== configuredMode) {
        configuredMode = mode;
        setModeBindings(effects!, targets!, mode);
      }
    };
    const dt = opts.dt ?? 1 / 60;
    let time = opts.time ?? 1.2;
    for (const mode of ALL_MODES) {
      configureMode(mode);
      frame(gpu, (currentFrame) =>
        renderMode(currentFrame, effects!, targets!, colorTarget, mode, time)
      );
      await gpu.gpu.queue.onSubmittedWorkDone();
      await opts.onModeRendered?.(mode, await colorTarget.read(), colorTarget.size);
    }
    for (let i = 0; i < Math.max(1, opts.warmupFrames ?? 60); i++) {
      time += dt;
      configureMode(DEFAULT_ANTI_ALIASING_CONTROLS.mode);
      frame(gpu, (currentFrame) =>
        renderMode(
          currentFrame,
          effects!,
          targets!,
          colorTarget,
          DEFAULT_ANTI_ALIASING_CONTROLS.mode,
          time
        )
      );
    }
  } finally {
    await Promise.allSettled([gpu.gpu.queue.onSubmittedWorkDone(), gpu.settled()]);
    if (targets) destroyTargets(targets);
    if (effects) destroyEffects(effects);
  }
}
