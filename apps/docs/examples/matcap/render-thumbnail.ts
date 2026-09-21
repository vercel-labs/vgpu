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
  const failures: unknown[] = [];

  try {
    const scene = createScene(gpu);
    frame(gpu, (currentFrame) =>
      renderScene(currentFrame, scene, output, options.time ?? 3.1)
    );
  } catch (error) {
    failures.push(error);
  }

  for (const result of await Promise.allSettled([
    Promise.resolve().then(() => gpu.gpu.queue.onSubmittedWorkDone()),
    Promise.resolve().then(() => gpu.settled()),
  ])) {
    if (result.status === "rejected") failures.push(result.reason);
  }

  if (failures.length) throw failures[0];
}
