import { frame, type Gpu, type Target } from 'vgpu';
import { createScene } from './scene';

export async function renderThumbnail(gpu: Gpu, target: Target): Promise<void> {
  try {
    const shader = createScene(gpu, target);
    shader.set({ params: { tilt: [0.045, -0.035], pointer: [0.25, -0.25], hover: 0.85 } });
    await shader.compile(target);
    frame(gpu, (currentFrame) => currentFrame.pass(target, shader));
  } finally {
    await Promise.allSettled([
      Promise.resolve().then(() => gpu.gpu.queue.onSubmittedWorkDone()),
      Promise.resolve().then(() => gpu.settled()),
    ]);
  }
}
