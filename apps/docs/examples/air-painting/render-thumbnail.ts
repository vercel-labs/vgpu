/**
 * ORT-free thumbnail for the air-painting example.
 *
 * The deterministic path uploads the canned frame, then replays the golden
 * landmark sequence through the production visual pipeline. It deliberately
 * has no dependency on ONNX Runtime Web, a webcam, the network, or browser APIs.
 */
import type { Gpu, Target } from 'vgpu';
import type { ThumbnailOptions } from '../../lib/example-renderer';
import {
  createFixtureFrame,
  FIXTURE_FRAME_HEIGHT,
  FIXTURE_FRAME_WIDTH,
  SYNTHETIC_DT,
  syntheticHandFrames,
} from './fixtures';
import {
  createLandmarkBuffer,
  createVisualPipeline,
  writeLandmarks,
  type HandResultInput,
} from './visual-pipeline';

/** Fixed timestep the golden sequence is authored for; mirrors `meta.thumb.dt`. */
export const THUMB_DT = SYNTHETIC_DT;

export async function renderThumbnail(
  gpu: Gpu,
  target: Target,
  _options: ThumbnailOptions = {}
): Promise<void> {
  const label = 'air-painting-thumb';
  const pipeline = createVisualPipeline(gpu, {
    sourceWidth: FIXTURE_FRAME_WIDTH,
    sourceHeight: FIXTURE_FRAME_HEIGHT,
    label,
  });
  const landmarkBuffers = [
    createLandmarkBuffer(gpu, label, 0),
    createLandmarkBuffer(gpu, label, 1),
  ];
  try {
    pipeline.writeFrame(createFixtureFrame());
    for (const frame of syntheticHandFrames(FIXTURE_FRAME_WIDTH, FIXTURE_FRAME_HEIGHT)) {
      const results: HandResultInput[] = [];
      for (const result of frame.results) {
        const buffer = landmarkBuffers[result.slot];
        if (!buffer) continue;
        pipeline.writeRoi(result.slot, result.roi);
        writeLandmarks(buffer, result.landmarks);
        results[result.slot] = { landmarks: buffer, presence: result.presence };
      }
      pipeline.consumeHandLandmarks(results, THUMB_DT);
    }
    pipeline.renderVisualFrame(target, { dpr: 1, hasFrame: true, showCursor: true });
  } finally {
    await Promise.allSettled([
      Promise.resolve().then(() => gpu.gpu.queue.onSubmittedWorkDone()),
      Promise.resolve().then(() => gpu.settled()),
    ]);
    for (const buffer of landmarkBuffers) buffer.dispose();
    pipeline.dispose();
  }
}
