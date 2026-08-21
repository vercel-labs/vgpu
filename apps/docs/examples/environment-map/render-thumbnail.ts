import type { Gpu, Target } from 'vgpu';
import { frame } from 'vgpu';

import type { ThumbnailOptions } from '../../lib/example-renderer';
import { cameraView } from './camera';
import { aspectOf, createScene, destroyScene, render } from './scene';

export async function renderThumbnail(
  gpu: Gpu,
  output: Target,
  opts: ThumbnailOptions = {}
): Promise<void> {
  const scene = await createScene(gpu, output);
  try {
    const dt = opts.dt ?? 1 / 60;
    let time = opts.time ?? 2.1;
    for (let i = 0; i < Math.max(1, opts.warmupFrames ?? 3); i++) {
      time += dt;
      const view = cameraView(0.62 + time * 0.09, 0.16, aspectOf(output));
      frame(gpu, (currentFrame) => render(currentFrame, scene, output, view, time));
    }
    await gpu.gpu.queue.onSubmittedWorkDone();
    await gpu.settled();
  } finally {
    destroyScene(scene);
  }
}
