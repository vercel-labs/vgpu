import { frame, target, type Gpu, type Target } from "vgpu";

import {
  createLiquidGeoScene,
  destroyLiquidGeoScene,
  renderLiquidGeo,
  type LiquidGeoScene,
} from "./simulation";

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
  let scene: LiquidGeoScene | undefined;
  let failure: unknown;
  try {
    scene = await createLiquidGeoScene(gpu, output);
    const dt = options.dt ?? 1 / 60;
    let time = options.time ?? 2.8;
    for (let i = 0; i < (options.warmupFrames ?? 90); i++) {
      time += dt;
      frame(gpu, (currentFrame) =>
        renderLiquidGeo(currentFrame, scene!, output, {
          time,
          deltaTime: dt,
          pointer: [0.34, 0.12],
          pointerStrength: 0.72,
          reducedMotion: false,
          earthMix: 0,
        })
      );
    }
  } catch (error) {
    failure = error;
  }

  const barriers = await Promise.allSettled([
    gpu.gpu.queue.onSubmittedWorkDone(),
    gpu.settled(),
  ]);
  if (scene) destroyLiquidGeoScene(scene);
  if (failure) throw failure;
  const rejected = barriers.find(
    (result): result is PromiseRejectedResult => result.status === "rejected"
  );
  if (rejected) throw rejected.reason;
}
