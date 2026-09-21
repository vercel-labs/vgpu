import { frame, target, type Gpu, type Target } from "vgpu";

import {
  createBlit,
  createScene,
  renderScene,
  type BatchScene,
} from "./scene-pipeline";

interface ThumbnailOptions {
  readonly warmupFrames?: number;
  readonly time?: number;
  readonly dt?: number;
}

export async function renderThumbnail(
  gpu: Gpu,
  output: Target,
  options: ThumbnailOptions = {}
): Promise<void> {
  let colorTarget: Target | undefined;
  let scene: BatchScene | undefined;
  const failures: unknown[] = [];

  try {
    colorTarget = target(gpu, {
      size: output.size,
      format: "rgba8unorm",
      depth: true,
    });
    const blit = createBlit(gpu, colorTarget, output);
    const prepared = await Promise.allSettled([
      Promise.resolve().then(() => createScene(gpu, colorTarget!)),
      Promise.resolve().then(() => blit.compile(output)),
    ]);
    if (prepared[0].status === "fulfilled") scene = prepared[0].value;
    const preparationFailure = prepared.find(
      (result): result is PromiseRejectedResult => result.status === "rejected"
    );
    if (preparationFailure) throw preparationFailure.reason;

    let time = options.time ?? 2.4;
    for (let index = 0; index < (options.warmupFrames ?? 3); index++) {
      time += options.dt ?? 1 / 60;
      frame(gpu, (currentFrame) =>
        renderScene(currentFrame, scene!, blit, colorTarget!, output, time)
      );
    }
  } catch (error) {
    failures.push(error);
  }

  for (const result of await Promise.allSettled([
    Promise.resolve().then(() => gpu.gpu.queue.onSubmittedWorkDone()),
    Promise.resolve().then(() => gpu.settled()),
  ])) {
    if (result.status === "rejected") failures.push(result.reason);
  }
  for (const cleanup of [
    () => scene?.geometry.destroy(),
    () => colorTarget && destroyTarget(colorTarget),
  ]) {
    try {
      cleanup();
    } catch (error) {
      failures.push(error);
    }
  }

  if (failures.length) throw failures[0];
}

function destroyTarget(value: Target): void {
  (value as Target & { destroy(): void }).destroy();
}
