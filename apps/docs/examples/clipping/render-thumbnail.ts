import type { Gpu, Target } from "vgpu";
import { frame } from "vgpu";

import { createScene, destroyScene, renderScene } from "./scene";

interface ThumbnailOptions {
  readonly time?: number;
}

export async function renderThumbnail(
  gpu: Gpu,
  output: Target,
  options: ThumbnailOptions = {}
): Promise<void> {
  let scene: ReturnType<typeof createScene> | undefined;
  const failures: unknown[] = [];

  try {
    const activeScene = createScene(gpu);
    scene = activeScene;
    frame(gpu, (currentFrame) =>
      renderScene(currentFrame, activeScene, output, options.time ?? 2.4)
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

  if (scene) {
    try {
      destroyScene(scene);
    } catch (error) {
      failures.push(error);
    }
  }

  if (failures.length) throw failures[0];
}
