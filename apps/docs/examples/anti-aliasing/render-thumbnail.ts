import { frame, type Gpu, type Target } from 'vgpu';

import { ALL_MODES, createScene, DEFAULT_MODE, type AaMode } from './scene';

interface ThumbOptions {
  readonly warmupFrames?: number;
  readonly time?: number;
  readonly dt?: number;
  readonly onModeRendered?: (
    mode: AaMode,
    pixels: Uint8Array,
    size: readonly [number, number],
  ) => void | Promise<void>;
}

export async function renderThumbnail(
  gpu: Gpu,
  output: Target,
  options: ThumbOptions = {},
): Promise<void> {
  let scene: ReturnType<typeof createScene> | undefined;

  try {
    scene = createScene(gpu, output);
    await scene.prewarm();
    let time = options.time ?? 1.2;

    for (const mode of ALL_MODES) {
      frame(gpu, (currentFrame) => scene!.render(currentFrame, mode, time));
      await gpu.gpu.queue.onSubmittedWorkDone();
      await options.onModeRendered?.(mode, await output.color.read({ mipLevel: 0, region: "all" }), output.size);
    }
    for (let i = 0; i < Math.max(1, options.warmupFrames ?? 60); i++) {
      time += options.dt ?? 1 / 60;
      frame(gpu, (currentFrame) => scene!.render(currentFrame, DEFAULT_MODE, time));
    }
  } finally {
    await Promise.allSettled([
      Promise.resolve().then(() => gpu.gpu.queue.onSubmittedWorkDone()),
      Promise.resolve().then(() => gpu.settled()),
    ]);
    scene?.destroy();
  }
}
