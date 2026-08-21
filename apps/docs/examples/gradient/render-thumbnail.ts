import type { Gpu, Target } from 'vgpu';
import { effect, frame } from 'vgpu';

import fragment from './shader.wgsl';

export async function renderThumbnail(gpu: Gpu, target: Target): Promise<void> {
  try {
    const shader = effect(gpu, fragment);
    frame(gpu, (currentFrame) => currentFrame.pass(target, shader));
  } finally {
    await Promise.allSettled([
      Promise.resolve().then(() => gpu.gpu.queue.onSubmittedWorkDone()),
      Promise.resolve().then(() => gpu.settled()),
    ]);
  }
}
