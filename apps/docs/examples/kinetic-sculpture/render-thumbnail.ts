import { frame, type Gpu, type Target } from 'vgpu';

import { createCamera, lightMatrices } from './camera';
import { createPipeline, renderSculpture } from './pipeline';
import { buildMobile, createCollections, DEFAULT_LEVELS, poseMobile } from './scene';

interface Options {
  readonly warmupFrames?: number;
  readonly dt?: number;
  readonly time?: number;
  readonly publicAssetsRoot?: string;
}

/** The default four-level mobile at a fixed, closed-form moment, through the live pipeline. */
export async function renderThumbnail(gpu: Gpu, target: Target, options: Options = {}): Promise<void> {
  const failures: unknown[] = [];
  try {
    const collections = createCollections();
    const mobile = buildMobile(collections, DEFAULT_LEVELS);
    const pipeline = await createPipeline(gpu, collections, target.size, target.format);
    const camera = createCamera();
    const light = lightMatrices(mobile.center, mobile.radius, {
      view: new Float32Array(16),
      viewProjection: new Float32Array(16),
    });
    // Warm-up frames step toward `time` by `dt`; the pose is closed-form, so the last frame is
    // the same image however many frames ran before it.
    const frames = Math.max(1, options.warmupFrames ?? 1);
    const dt = options.dt ?? 1 / 60;
    const time = options.time ?? 6.5;
    for (let index = 0; index < frames; index += 1) {
      poseMobile(mobile, { time: time - (frames - 1 - index) * dt, swing: 1, rootAngle: 0 });
      frame(gpu, (currentFrame) =>
        renderSculpture(currentFrame, pipeline, collections, { mobile, camera, light }, target, 0),
      );
    }
  } catch (error) {
    failures.push(error);
  } finally {
    for (const result of await Promise.allSettled([
      Promise.resolve().then(() => gpu.gpu.queue.onSubmittedWorkDone()),
      Promise.resolve().then(() => gpu.settled()),
    ])) {
      if (result.status === 'rejected') failures.push(result.reason);
    }
  }
  if (failures.length > 0) throw failures[0];
}
