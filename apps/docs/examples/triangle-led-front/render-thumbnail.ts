import type { Gpu, Target } from 'vgpu';
import { frame } from 'vgpu';

import type { ThumbnailOptions } from '../../lib/example-renderer';
import { createHeroRenderer } from './scene-renderer';
import { DEFAULT_BRUSH } from './settings';
import { brushState, heroStateForActiveClick } from './sim-sizing';
import { DEFAULT_TRIANGLE_LED_CONTROLS } from './types';

export async function renderThumbnail(
  gpu: Gpu,
  target: Target,
  opts: ThumbnailOptions = {}
): Promise<void> {
  const scene = createHeroRenderer(gpu, {
    theme: 'dark',
    css: { width: target.size[0], height: target.size[1], dpr: 1 },
  });
  try {
    scene.setOutputTarget(target);
    scene.setHero(heroStateForActiveClick(DEFAULT_TRIANGLE_LED_CONTROLS.mode));
    scene.setRgbDeployActive(false);
    scene.setBrush(brushState(DEFAULT_BRUSH));
    await scene.prewarm();
    const warmupFrames = opts.warmupFrames ?? 90;
    const dt = opts.dt ?? 1 / 60;
    let time = opts.time ?? 0;
    for (let i = 0; i < warmupFrames; i++) {
      time += dt;
      frame(gpu, (currentFrame) => scene.renderFrame(currentFrame, { time, dt }));
    }
  } finally {
    await Promise.allSettled([
      Promise.resolve().then(() => gpu.gpu.queue.onSubmittedWorkDone()),
      Promise.resolve().then(() => gpu.settled()),
    ]);
    try {
      scene.destroy();
    } catch {
      /* Preserve the original render failure. */
    }
  }
}
