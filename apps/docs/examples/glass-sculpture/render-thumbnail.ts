import { frame, type Gpu, type Target } from 'vgpu';
import { cameraState, DEFAULT_PITCH, DEFAULT_RADIUS, DEFAULT_YAW } from './camera';
import { createScene, DEFAULT_CONTROLS } from './scene';

interface ThumbnailOptions {
  readonly warmupFrames?: number;
  readonly dt?: number;
  readonly time?: number;
}

export async function renderThumbnail(
  gpu: Gpu,
  output: Target,
  options: ThumbnailOptions = {},
): Promise<void> {
  const controls = { ...DEFAULT_CONTROLS, renderScale: 1 as const };
  let scene: ReturnType<typeof createScene> | undefined;
  let primaryError: unknown;
  try {
    const activeScene = createScene(gpu, output, controls);
    scene = activeScene;
    await activeScene.prepare(output);
    const frames = Math.max(1, options.warmupFrames ?? 3);
    const dt = options.dt ?? 1 / 60;
    const time = options.time ?? 1.6;
    for (let index = 0; index < frames; index++) {
      frame(gpu, (currentFrame) => {
        activeScene.render(
          currentFrame,
          output,
          cameraState(DEFAULT_YAW, DEFAULT_PITCH, DEFAULT_RADIUS),
          controls,
          {
            sculptureTime: time,
            clockTime: 0,
            deltaTime: dt,
            light: { azimuth: 0.9, elevation: 0.55 },
          },
        );
      });
    }
  } catch (error) {
    primaryError = error;
  }

  const barriers = await Promise.allSettled([
    Promise.resolve().then(() => gpu.gpu.queue.onSubmittedWorkDone()),
    Promise.resolve().then(() => gpu.settled()),
  ]);
  const barrierError = barriers.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  )?.reason;
  let cleanupError: unknown;
  try {
    scene?.destroy();
  } catch (error) {
    cleanupError = error;
  }

  if (primaryError !== undefined) throw primaryError;
  if (barrierError !== undefined) throw barrierError;
  if (cleanupError !== undefined) throw cleanupError;
}
