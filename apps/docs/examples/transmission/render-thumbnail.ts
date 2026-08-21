import type { Gpu, Target } from 'vgpu';

import type { ThumbnailOptions } from '../../lib/example-renderer';
import { cameraView, DEFAULT_PITCH, DEFAULT_YAW } from './camera';
import { aspectOf, createScene, destroyScene, renderScene } from './scene';
import { DEFAULT_TRANSMISSION_CONTROLS } from './types';

export async function renderThumbnail(
  gpu: Gpu,
  output: Target,
  opts: ThumbnailOptions = {}
): Promise<void> {
  const scene = await createScene(gpu, output, 'transmission-thumb');
  try {
    const view = cameraView(DEFAULT_YAW, DEFAULT_PITCH, aspectOf(output));
    for (let i = 0; i < Math.max(1, opts.warmupFrames ?? 3); i++)
      renderScene(gpu, scene, output, view, DEFAULT_TRANSMISSION_CONTROLS);
    await gpu.gpu.queue.onSubmittedWorkDone();
    await gpu.settled();
  } finally {
    destroyScene(scene);
  }
}
