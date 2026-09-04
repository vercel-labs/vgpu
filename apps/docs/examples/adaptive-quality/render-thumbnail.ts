import { frame, type Gpu, type Target } from 'vgpu';

import { createScene, type Scene } from './scene';

interface ThumbOptions {
  readonly warmupFrames?: number;
  readonly time?: number;
  readonly dt?: number;
}

/** Deterministic High-tier render; no signals run here. */
export async function renderThumbnail(gpu: Gpu, output: Target, options: ThumbOptions = {}): Promise<void> {
  let scene: Scene | undefined;
  try {
    scene = createScene(gpu, output, 'high');
    await scene.prepare();
    let time = options.time ?? 2.5;
    const dt = options.dt ?? 1 / 60;
    for (let i = 0; i < Math.max(1, options.warmupFrames ?? 30); i++) {
      frame(gpu, (currentFrame) => scene!.render(currentFrame, time));
      time += dt;
    }
  } finally {
    await Promise.allSettled([
      Promise.resolve().then(() => gpu.gpu.queue.onSubmittedWorkDone()),
      Promise.resolve().then(() => gpu.settled()),
    ]);
    scene?.destroy();
  }
}
