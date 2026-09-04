import type { Gpu, Target } from "vgpu";

import { DEFAULT_PITCH, DEFAULT_YAW, cameraView } from "./camera";
import {
  DEFAULT_CONTROLS,
  createScene,
  destroyScene,
  renderScene,
  type SculptureControls,
} from "./scene";

interface ThumbnailOptions {
  readonly warmupFrames?: number;
  readonly dt?: number;
  readonly time?: number;
}

/** Deterministic still: the turntable is parked and the key light is fixed. */
const THUMBNAIL_CONTROLS: SculptureControls = {
  ...DEFAULT_CONTROLS,
  renderScale: 1,
};
const THUMBNAIL_TIME = 1.6;
const THUMBNAIL_LIGHT = { azimuth: 0.9, elevation: 0.55 } as const;

export async function renderThumbnail(
  gpu: Gpu,
  output: Target,
  opts: ThumbnailOptions = {}
): Promise<void> {
  let scene: Awaited<ReturnType<typeof createScene>> | undefined;
  let primaryError: unknown;
  let failed = false;
  try {
    scene = await createScene(gpu, output, THUMBNAIL_CONTROLS);
    const view = cameraView(DEFAULT_YAW, DEFAULT_PITCH);
    const time = opts.time ?? THUMBNAIL_TIME;
    for (let i = 0; i < Math.max(1, opts.warmupFrames ?? 3); i++) {
      renderScene(gpu, scene, output, view, THUMBNAIL_CONTROLS, {
        time,
        clock: 0,
        light: THUMBNAIL_LIGHT,
      });
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
