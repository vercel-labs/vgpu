import { frame, type Gpu, type Target } from 'vgpu';

import {
  DEFAULT_SPRING,
  DEFAULT_STAGGER,
  activeSegments,
  bakeSpring,
  bakeStagger,
  baseShape,
  cameraAt,
  morphWindow,
} from './choreography';
import { DEFAULT_COUNT, createPipeline } from './pipeline';

interface ThumbOptions {
  readonly warmupFrames?: number;
  /** Timeline seconds of the last frame; the default is the knot overshooting out of the sphere. */
  readonly time?: number;
  readonly dt?: number;
}

/**
 * The live chain at a fixed playhead. Every frame is a pure function of
 * timeline time, so the still needs no simulation history: no pointer, no
 * trails, and the camera and swarm exactly as the page shows them there.
 */
export async function renderThumbnail(gpu: Gpu, output: Target, options: ThumbOptions = {}): Promise<void> {
  try {
    const pipeline = createPipeline(gpu, { count: DEFAULT_COUNT });
    const spring = bakeSpring(DEFAULT_SPRING);
    pipeline.setSpring(spring, bakeStagger(DEFAULT_STAGGER.spread, DEFAULT_STAGGER.ease), DEFAULT_STAGGER.spread);
    pipeline.resize(output.size, 1);
    await pipeline.prewarm(output);

    const end = options.time ?? 6.4;
    const dt = options.dt ?? 1 / 60;
    const frames = Math.max(1, options.warmupFrames ?? 1);
    const aspect = output.size[0] / output.size[1];
    const inFlight = morphWindow(DEFAULT_STAGGER.spread, spring.duration);
    for (let i = 0; i < frames; i++) {
      const time = end - (frames - 1 - i) * dt;
      const camera = cameraAt(time, aspect);
      const segments = activeSegments(time, inFlight);
      frame(gpu, (currentFrame) =>
        pipeline.encode(currentFrame, output, {
          time,
          viewProjection: camera.viewProjection,
          yaw: camera.yaw,
          baseShape: baseShape(time, segments),
          segments,
          pattern: 'auto',
          bursts: [],
          pointer: { position: [0, 0], velocity: [0, 0], strength: 0, radius: 1 },
          keep: 0,
        }),
      );
    }
  } finally {
    await Promise.allSettled([
      Promise.resolve().then(() => gpu.gpu.queue.onSubmittedWorkDone()),
      Promise.resolve().then(() => gpu.settled()),
    ]);
  }
}
