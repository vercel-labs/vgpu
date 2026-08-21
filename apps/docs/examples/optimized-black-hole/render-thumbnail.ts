import type { Gpu, Target } from 'vgpu';
import * as vgpu from 'vgpu';

import type { ThumbnailOptions } from '../../lib/example-renderer';
import {
  createEffects,
  createTargets,
  destroyTargets,
  prewarm,
  renderChain,
  setBakeUniforms,
  setBindings,
  setPostUniforms,
  setShadeUniforms,
} from './pipeline';
import { defaultHeroSettings } from './settings';

export async function renderThumbnail(
  gpu: Gpu,
  output: Target,
  opts: ThumbnailOptions = {}
): Promise<void> {
  const settings = defaultHeroSettings();
  const effects = createEffects(vgpu, gpu, 'optimized-black-hole-thumb');
  const targets = createTargets(vgpu, gpu, output.size, 'optimized-black-hole-thumb');
  try {
    setBindings(effects, targets);
    setBakeUniforms(effects, targets, settings);
    setPostUniforms(effects, targets, settings);
    await prewarm(effects, targets, output);
    const dt = opts.dt ?? 1 / 60;
    let time = opts.time ?? 2.5;
    const frames = Math.max(1, opts.warmupFrames ?? 1);
    for (let i = 0; i < frames; i++) {
      setShadeUniforms(effects, targets, settings, time, 0);
      vgpu.frame(gpu, (currentFrame) =>
        renderChain(currentFrame, effects, targets, output, settings, i === 0)
      );
      time += dt;
    }
    await gpu.gpu.queue.onSubmittedWorkDone();
    await gpu.settled();
  } finally {
    await Promise.allSettled([gpu.gpu.queue.onSubmittedWorkDone(), gpu.settled()]);
    destroyTargets(targets);
    effects.noiseVolume.destroy();
  }
}
