import type { Gpu, Target } from "vgpu";
import { frame } from "vgpu";

import { EARTH_TUNING } from "./planet";
import {
  bakeMaps,
  createMaps,
  createScene,
  createTargets,
  destroyMaps,
  destroyScene,
  destroyTargets,
  prewarm,
  render,
  setFrameUniforms,
  setStaticBindings,
} from "./renderer";

interface ThumbnailOptions {
  readonly warmupFrames?: number;
  readonly time?: number;
  readonly dt?: number;
}

export async function renderThumbnail(
  gpu: Gpu,
  output: Target,
  opts: ThumbnailOptions = {}
): Promise<void> {
  let maps: ReturnType<typeof createMaps> | undefined;
  let scene: ReturnType<typeof createScene> | undefined;
  let targets: ReturnType<typeof createTargets> | undefined;
  let failed = false;
  try {
    const currentMaps = createMaps(gpu);
    maps = currentMaps;
    const currentScene = createScene(gpu);
    scene = currentScene;
    const currentTargets = createTargets(gpu, output.size);
    targets = currentTargets;
    setStaticBindings(currentScene, currentMaps, currentTargets);
    await Promise.all([
      bakeMaps(gpu, currentMaps),
      prewarm(currentScene, currentTargets, output),
    ]);
    const { yaw, pitch, radius, sunDegrees } = EARTH_TUNING.poster;
    const dt = opts.dt ?? 1 / 60;
    let time = opts.time ?? 0;
    for (let i = 0; i < Math.max(1, opts.warmupFrames ?? 1); i++) {
      setFrameUniforms(
        currentScene,
        output,
        { yaw, pitch, radius },
        sunDegrees + time * EARTH_TUNING.sun.degreesPerSecond,
        time
      );
      frame(gpu, (currentFrame) =>
        render(currentFrame, currentScene, currentTargets, output)
      );
      time += dt;
    }
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    await Promise.allSettled([
      Promise.resolve().then(() => gpu.gpu.queue.onSubmittedWorkDone()),
      Promise.resolve().then(() => gpu.settled()),
    ]);
    let cleanupError: unknown;
    let cleanupFailed = false;
    for (const cleanup of [
      () => targets && destroyTargets(targets),
      () => scene && destroyScene(scene),
      () => maps && destroyMaps(maps),
    ]) {
      try {
        cleanup();
      } catch (error) {
        if (!cleanupFailed) cleanupError = error;
        cleanupFailed = true;
      }
    }
    if (!failed && cleanupFailed) throw cleanupError;
  }
}
