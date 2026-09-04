import { frame, type Gpu, type Target } from "vgpu";

import { createLiquidGlassScene } from "./renderer";

interface ThumbnailOptions {
  readonly time?: number;
}

export async function renderThumbnail(
  gpu: Gpu,
  output: Target,
  options: ThumbnailOptions = {},
): Promise<void> {
  const scene = createLiquidGlassScene(gpu, output);
  try {
    scene.setParams(options.time ?? 2.4);
    frame(gpu, (currentFrame) => currentFrame.pass(output, scene.shader));
  } finally {
    await Promise.allSettled([
      Promise.resolve().then(() => gpu.gpu.queue.onSubmittedWorkDone()),
      Promise.resolve().then(() => gpu.settled()),
    ]);
    scene.dispose();
  }
}
