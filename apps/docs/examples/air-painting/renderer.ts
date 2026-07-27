/**
 * ORT-free thumbnail for the air-painting example.
 *
 * `scripts/render-example-thumbs.mjs` bundles this module for Node, so it must
 * never import ONNX Runtime Web, not even dynamically, and must never touch a
 * webcam, the network, or a browser API. Session orchestration lives in
 * `ort-runtime.ts`; the shaders and resources live in `visual-pipeline.ts`.
 *
 * What the thumbnail actually does: upload the canned frame, replay 24 golden
 * `[1,1,17,3]` keypoint buffers through the **production** `wrist.wgsl` and
 * `paint.wgsl` at a fixed `dt = 1/30`, then composite once with
 * `composite.wgsl`.
 *
 * What that proves: the visual pipeline, the transform, the state machine and
 * the accumulation are all correct and deterministic. What it does **not** prove:
 * anything at all about ORT interop, device adoption, or zero-copy. Only the
 * real-browser evidence in `public/models/movenet/PROVENANCE.md` does that.
 */
import type { Gpu, Target } from 'vgpu';
import type { ThumbnailOptions } from '../../lib/example-renderer';
import {
  createFixtureFrame,
  FIXTURE_FRAME_HEIGHT,
  FIXTURE_FRAME_WIDTH,
  fixtureTransform,
  SYNTHETIC_DT,
  syntheticKeypointFrames,
} from './fixtures';
import {
  createKeypointBuffer,
  createVisualPipeline,
  writeKeypoints,
  type VisualPipeline,
} from './visual-pipeline';

export { createVisualPipeline, createKeypointBuffer, writeKeypoints } from './visual-pipeline';
export type { VisualPipeline, VisualFrameOptions } from './visual-pipeline';

/** Fixed timestep the golden sequence is authored for; mirrors `meta.thumb.dt`. */
export const THUMB_DT = SYNTHETIC_DT;

export async function renderThumbnail(
  gpu: Gpu,
  target: Target,
  _options: ThumbnailOptions = {},
): Promise<void> {
  const label = 'air-painting-thumb';
  const pipeline = createVisualPipeline(gpu, {
    sourceWidth: FIXTURE_FRAME_WIDTH,
    sourceHeight: FIXTURE_FRAME_HEIGHT,
    label,
  });
  const keypoints = createKeypointBuffer(gpu, label);
  try {
    pipeline.writeFrame(createFixtureFrame());
    // Every sample goes through the real wrist state machine, so the first one
    // only acquires the pose and the visible stroke starts at the second.
    for (const golden of syntheticKeypointFrames(fixtureTransform())) {
      writeKeypoints(keypoints, golden);
      pipeline.consumeKeypoints(keypoints, THUMB_DT);
    }
    pipeline.renderVisualFrame(target, { dpr: 1, hasFrame: true, showCursor: true });
  } finally {
    // Always drain and settle, including when encoding throws.
    await Promise.allSettled([
      Promise.resolve().then(() => gpu.gpu.queue.onSubmittedWorkDone()),
      Promise.resolve().then(() => gpu.settled()),
    ]);
    keypoints.dispose();
    pipeline.dispose();
  }
}
