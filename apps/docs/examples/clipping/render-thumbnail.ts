import type { Gpu, Target } from 'vgpu';
import { frame } from 'vgpu';

import type { ThumbnailOptions } from '../../lib/example-renderer';
import { createScene, destroyScene, renderScene } from './scene';

export async function renderThumbnail(
  gpu: Gpu,
  output: Target,
  options: ThumbnailOptions = {}
): Promise<void> {
  const scene = createScene(gpu);
  try {
    frame(gpu, (currentFrame) => renderScene(currentFrame, scene, output, options.time ?? 2.4));
  } finally {
    await Promise.allSettled([
      Promise.resolve().then(() => gpu.gpu.queue.onSubmittedWorkDone()),
      Promise.resolve().then(() => gpu.settled()),
    ]);
    destroyScene(scene);
  }
}
