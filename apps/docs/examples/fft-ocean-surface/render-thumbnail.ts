import { frame, type Gpu, type Target } from "vgpu";
import { perspectiveCamera } from "vgpu/scene";

import { buildOcean, OCEAN_CAMERA, type OceanScene } from "./scene";

interface ThumbnailOptions {
  readonly dt?: number;
  readonly time?: number;
  readonly warmupFrames?: number;
}

export async function renderThumbnail(
  gpu: Gpu,
  output: Target,
  options: ThumbnailOptions = {}
): Promise<void> {
  let scene: OceanScene | undefined;
  let primaryError: unknown;
  let failed = false;
  try {
    scene = buildOcean(gpu, output.size);
    const camera = perspectiveCamera({
      ...OCEAN_CAMERA,
      aspect: output.size[0] / output.size[1],
    });
    const dt = options.dt ?? 1 / 60;
    const warmup = Math.max(0, options.warmupFrames ?? 0);
    for (let index = 0; index < warmup; index++) scene.simulate(dt);
    scene.simulate((options.time ?? 9) - warmup * dt);
    scene.updateCamera(camera.viewProjection, camera.worldPosition);
    frame(gpu, (currentFrame) => {
      currentFrame.pass({ target: scene!.hdr, clear: scene!.clear }, (pass) => {
        pass.draw(scene!.skydome);
        pass.draw(scene!.ocean);
      });
      currentFrame.pass(output, scene!.composite);
    });
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
    scene?.destroy();
  } catch (error) {
    if (!cleanupFailed) cleanupError = error;
    cleanupFailed = true;
  }

  if (failed) throw primaryError;
  if (cleanupFailed) throw cleanupError;
}
