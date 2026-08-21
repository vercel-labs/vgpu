import type { Gpu, Target } from 'vgpu';
import { frame, target } from 'vgpu';

import type { ThumbnailOptions } from '../../lib/example-renderer';
import { createBlit, createScene, renderScene, type BatchScene } from './scene-pipeline';

export async function renderThumbnail(
  gpu: Gpu,
  output: Target,
  opts: ThumbnailOptions = {}
): Promise<void> {
  const colorTarget = target(gpu, { size: output.size, format: 'rgba8unorm', depth: true });
  let scene: BatchScene | undefined;
  try {
    const blit = createBlit(gpu, colorTarget, output);
    scene = await createScene(gpu, colorTarget);
    await blit.compile(output);
    let time = opts.time ?? 2.4;
    for (let i = 0; i < (opts.warmupFrames ?? 3); i++) {
      time += opts.dt ?? 1 / 60;
      frame(gpu, (currentFrame) =>
        renderScene(currentFrame, scene!, blit, colorTarget, output, time)
      );
    }
  } finally {
    await Promise.allSettled([
      Promise.resolve().then(() => gpu.gpu.queue.onSubmittedWorkDone()),
      Promise.resolve().then(() => gpu.settled()),
    ]);
    scene?.geometry.destroy();
    (colorTarget as { destroy?: () => void }).destroy?.();
  }
}
