import type { Gpu, Target } from "vgpu";

import { cameraView, DEFAULT_PITCH, DEFAULT_YAW } from "./camera";
import {
  DEFAULT_CONTROLS,
  aspectOf,
  createScene,
  destroyScene,
  renderScene,
} from "./scene";

interface ThumbnailOptions {
  readonly warmupFrames?: number;
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
    const view = cameraView(DEFAULT_YAW, DEFAULT_PITCH, aspectOf(output));
    for (let i = 0; i < Math.max(1, opts.warmupFrames ?? 3); i++) {
      renderScene(gpu, scene, output, view, DEFAULT_CONTROLS);
    }
  } catch (error) {
    primaryError = error;
    failed = true;
  }

  const barriers = await Promise.allSettled([
    Promise.resolve().then(() => gpu.gpu.queue.onSubmittedWorkDone()),
    Promise.resolve().then(() => gpu.settled()),
  ]);
  const rejectedBarrier = barriers.find(
    (result): result is PromiseRejectedResult => result.status === "rejected"
  );
  let cleanupError = rejectedBarrier?.reason;
  let cleanupFailed = rejectedBarrier !== undefined;
  try {
    if (scene) destroyScene(scene);
  } catch (error) {
    if (!cleanupFailed) cleanupError = error;
    cleanupFailed = true;
  }

  if (failed) throw primaryError;
  if (cleanupFailed) throw cleanupError;
}
