import { frame, target, type Gpu, type Target } from "vgpu";

import {
  createBlit,
  createScene,
  DEFAULT_INSTANCE_COUNT,
  renderScene,
  type InstancedScene,
} from "./scene-pipeline";

interface ThumbnailOptions {
  readonly time?: number;
  readonly warmupFrames?: number;
  readonly dt?: number;
}

export async function renderThumbnail(
  gpu: Gpu,
  output: Target,
  options: ThumbnailOptions = {}
): Promise<void> {
  let colorTarget: Target | undefined;
  let scene: InstancedScene | undefined;
  let failure: { reason: unknown } | undefined;

  try {
    colorTarget = target(gpu, {
      size: output.size,
      format: "rgba8unorm",
      depth: true,
    });
    const localTarget = colorTarget;
    const [sceneResult, blitResult] = await Promise.allSettled([
      Promise.resolve().then(() =>
        createScene(gpu, localTarget, DEFAULT_INSTANCE_COUNT)
      ),
      Promise.resolve().then(async () => {
        const blit = createBlit(gpu, localTarget, output);
        await blit.compile(output);
        return blit;
      }),
    ]);
    if (sceneResult.status === "fulfilled") scene = sceneResult.value;
    if (sceneResult.status === "rejected") throw sceneResult.reason;
    if (blitResult.status === "rejected") throw blitResult.reason;

    let time = options.time ?? 2.4;
    for (let i = 0; i < (options.warmupFrames ?? 3); i++) {
      time += options.dt ?? 1 / 60;
      frame(gpu, (currentFrame) =>
        renderScene(
          currentFrame,
          sceneResult.value,
          blitResult.value,
          localTarget,
          output,
          time
        )
      );
    }
  } catch (error) {
    failure = { reason: error };
  }

  const barriers = await Promise.allSettled([
    Promise.resolve().then(() => gpu.gpu.queue.onSubmittedWorkDone()),
    Promise.resolve().then(() => gpu.settled()),
  ]);
  const cleanupFailure = cleanupLocal(scene, colorTarget);

  if (failure) throw failure.reason;
  const barrierFailure = barriers.find(
    (result): result is PromiseRejectedResult => result.status === "rejected"
  );
  if (barrierFailure) throw barrierFailure.reason;
  if (cleanupFailure) throw cleanupFailure.reason;
}

function destroyTarget(value: Target): void {
  (value as Target & { destroy(): void }).destroy();
}

function cleanupLocal(
  scene: InstancedScene | undefined,
  colorTarget: Target | undefined
): { reason: unknown } | undefined {
  let failure: { reason: unknown } | undefined;
  for (const cleanup of [
    () => scene?.geometry.destroy(),
    () => colorTarget && destroyTarget(colorTarget),
  ]) {
    try {
      cleanup();
    } catch (reason) {
      failure ??= { reason };
    }
  }
  return failure;
}
