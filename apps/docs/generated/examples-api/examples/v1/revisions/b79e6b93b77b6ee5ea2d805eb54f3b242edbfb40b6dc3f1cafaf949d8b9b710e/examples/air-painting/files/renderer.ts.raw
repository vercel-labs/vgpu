/**
 * ORT-free thumbnail for the air-painting example.
 *
 * `scripts/render-example-thumbs.mjs` bundles this module for Node, so it must
 * never import ONNX Runtime Web, not even dynamically, and must never touch a
 * webcam, the network, or a browser API. Session orchestration lives in
 * `ort-runtime.ts`; the shaders and resources live in `visual-pipeline.ts`.
 *
 * What the thumbnail actually does: upload the canned frame, then replay 24
 * golden `[1,63]` landmark buffers — each with the ROI it was cropped through —
 * through the **production** `hand.wgsl` and `paint.wgsl` at a fixed
 * `dt = 1/30`, and composite once with `composite.wgsl`.
 *
 * That exercises the real inverse crop transform, the real MCP centroid, the
 * real mirror and the real two-slot state machine. It does **not** exercise the
 * tracking loopback's effect on the next crop, because there is no camera to
 * crop from — each result supplies its own ROI, exactly as the detector would on
 * a reacquisition frame.
 *
 * What it proves: the visual pipeline, the geometry, the state machine and the
 * accumulation are correct and deterministic. What it does **not** prove:
 * anything at all about ORT interop, device adoption, or zero-copy. Only the
 * real-browser evidence in `public/models/mediapipe-hands/provenance.md` does
 * that.
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
  type VisualPipeline,
} from './visual-pipeline';

export {
  createLandmarkBuffer,
  createVisualPipeline,
  writeLandmarks,
} from './visual-pipeline';
export type { VisualPipeline, VisualFrameOptions, HandResultInput } from './visual-pipeline';

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
  const landmarkBuffers = [
    createLandmarkBuffer(gpu, label, 0),
    createLandmarkBuffer(gpu, label, 1),
  ];
  try {
    pipeline.writeFrame(createFixtureFrame());
    // Every sample goes through the real hand state machine, so the first one
    // only acquires the track and the visible stroke starts at the second.
    for (const frame of syntheticHandFrames(FIXTURE_FRAME_WIDTH, FIXTURE_FRAME_HEIGHT)) {
      const results: HandResultInput[] = [];
      for (const result of frame.results) {
        const buffer = landmarkBuffers[result.slot];
        if (!buffer) continue;
        // The ROI has to be in place before the dispatch reads it: `hand.wgsl`
        // maps landmarks out of crop space through exactly this region.
        pipeline.writeRoi(result.slot, result.roi);
        writeLandmarks(buffer, result.landmarks);
        results[result.slot] = { landmarks: buffer, presence: result.presence };
      }
      pipeline.consumeHandLandmarks(results, THUMB_DT);
    }
    pipeline.renderVisualFrame(target, { dpr: 1, hasFrame: true, showCursor: true });
  } finally {
    // Always drain and settle, including when encoding throws.
    await Promise.allSettled([
      Promise.resolve().then(() => gpu.gpu.queue.onSubmittedWorkDone()),
      Promise.resolve().then(() => gpu.settled()),
    ]);
    for (const buffer of landmarkBuffers) buffer.dispose();
    pipeline.dispose();
  }
}
