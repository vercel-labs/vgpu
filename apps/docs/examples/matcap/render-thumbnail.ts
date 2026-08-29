import type { Gpu, Target } from "vgpu";
import { frame } from "vgpu";

import { createScene, renderScene } from "./scene";

interface ThumbnailOptions {
  readonly time?: number;
}

export async function renderThumbnail(
  gpu: Gpu,
  output: Target,
  options: ThumbnailOptions = {}
): Promise<void> {
  try {
    const scene = createScene(gpu);
    frame(gpu, (currentFrame) =>
      renderScene(currentFrame, scene, output, options.time ?? 3.1)
    );
  } finally {
    await Promise.allSettled([
      Promise.resolve().then(() => gpu.gpu.queue.onSubmittedWorkDone()),
      Promise.resolve().then(() => gpu.settled()),
    ]);
  }
}
