import type { Buffer, Gpu, Target } from "vgpu";

import {
  createFixtureFrame,
  FIXTURE_FRAME_HEIGHT,
  FIXTURE_FRAME_WIDTH,
  SYNTHETIC_DT,
  syntheticHandFrames,
} from "./fixtures";
import {
  createLandmarkBuffer,
  createVisualPipeline,
  writeLandmarks,
  type HandResultInput,
  type VisualPipeline,
} from "./visual-pipeline";

export const THUMB_DT = SYNTHETIC_DT;

export async function renderThumbnail(gpu: Gpu, target: Target): Promise<void> {
  const label = "air-painting-thumb";
  let pipeline: VisualPipeline | undefined;
  const landmarks: Buffer[] = [];
  let failed = false;
  let primaryError: unknown;

  try {
    pipeline = createVisualPipeline(gpu, {
      sourceWidth: FIXTURE_FRAME_WIDTH,
      sourceHeight: FIXTURE_FRAME_HEIGHT,
      label,
    });
    landmarks.push(createLandmarkBuffer(gpu, label, 0));
    landmarks.push(createLandmarkBuffer(gpu, label, 1));
    pipeline.writeFrame(createFixtureFrame());
    for (const frame of syntheticHandFrames()) {
      const results: HandResultInput[] = [];
      for (const result of frame.results) {
        const buffer = landmarks[result.slot];
        if (!buffer) continue;
        pipeline.writeRoi(result.slot, result.roi);
        writeLandmarks(buffer, result.landmarks);
        results[result.slot] = { landmarks: buffer, presence: result.presence };
      }
      pipeline.consumeHandLandmarks(results, THUMB_DT);
    }
    pipeline.renderVisualFrame(target, {
      dpr: 1,
      hasFrame: true,
      showCursor: true,
    });
  } catch (error) {
    failed = true;
    primaryError = error;
  }

  const cleanupErrors: unknown[] = [];
  const barriers = await Promise.allSettled([
    Promise.resolve().then(() => gpu.gpu.queue.onSubmittedWorkDone()),
    Promise.resolve().then(() => gpu.settled()),
  ]);
  for (const result of barriers) {
    if (result.status === "rejected") cleanupErrors.push(result.reason);
  }
  for (const resource of [...landmarks.reverse(), pipeline]) {
    try {
      resource?.dispose();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }

  if (failed) throw primaryError;
  if (cleanupErrors.length) throw cleanupErrors[0];
}
