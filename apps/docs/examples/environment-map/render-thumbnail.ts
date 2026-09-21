import { frame, type Gpu, type Target } from "vgpu";

import { cameraView } from "./camera";
import { aspectOf, createScene, destroyScene, render } from "./scene";

interface ThumbnailOptions {
  readonly warmupFrames?: number;
  readonly dt?: number;
  readonly time?: number;
}

export async function renderThumbnail(
  gpu: Gpu,
  output: Target,
  opts: ThumbnailOptions = {}
): Promise<void> {
  let scene: Awaited<ReturnType<typeof createScene>> | undefined;
  let primaryError: unknown;
  let failed = false;
  try {
    scene = await createScene(gpu, output);
    const dt = opts.dt ?? 1 / 60;
    let time = opts.time ?? 2.1;
    for (let i = 0; i < Math.max(1, opts.warmupFrames ?? 3); i++) {
      time += dt;
      const view = cameraView(0.62 + time * 0.09, 0.16, aspectOf(output));
      frame(gpu, (currentFrame) =>
        render(currentFrame, scene!, output, view, time)
      );
    }
  } catch (error) {
    primaryError = error;
    failed = true;
  }

  const barriers = await Promise.allSettled([
    Promise.resolve().then(() => gpu.gpu.queue.onSubmittedWorkDone()),
    Promise.resolve().then(() => gpu.settled()),
  ]);
  const rejected = barriers.find(
    (result): result is PromiseRejectedResult => result.status === "rejected"
  );
  let cleanupError = rejected?.reason;
  let cleanupFailed = rejected !== undefined;
  try {
    if (scene) destroyScene(scene);
  } catch (error) {
    if (!cleanupFailed) cleanupError = error;
    cleanupFailed = true;
  }

  if (failed) throw primaryError;
  if (cleanupFailed) throw cleanupError;
}
