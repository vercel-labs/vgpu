/**
 * Node-only thumbnail entry.
 *
 * Kept separate from `renderer.ts` on purpose: the committed depth fixture is
 * 230 KB of base64 and the browser has no use for it, so importing it from a
 * module the example bundle pulls in would put it on the wire for every
 * visitor. Only `scripts/render-example-thumbs.mjs` imports this file.
 */
import type { Gpu, Target } from 'vgpu';
import type { ThumbnailOptions } from '../../lib/example-renderer';
import { decodeGoldenDepth, GOLDEN_MODEL_ID } from './fixtures';
import { getDepthModel } from './model-contract';
import { createDepthBuffer, createReliefPipeline, writeDepth } from './renderer';

/**
 * Deterministic thumbnail: uploads the depth field the default model produced
 * for the committed source image, then runs the production shader over it.
 *
 * This validates the visualizer. It proves nothing about ORT interop, which
 * needs a real browser and a real GPU.
 */
export async function renderThumbnail(
  gpu: Gpu,
  target: Target,
  _options: ThumbnailOptions = {},
): Promise<void> {
  const model = getDepthModel(GOLDEN_MODEL_ID);
  const relief = createReliefPipeline(gpu, 'depth-estimation-thumb');
  const depth = createDepthBuffer(gpu, model, 'depth-estimation-thumb');
  try {
    writeDepth(depth, decodeGoldenDepth());
    relief.draw(gpu, target, depth, model, { hasResult: true, parallax: [0, 0] });
  } finally {
    await Promise.allSettled([
      Promise.resolve().then(() => gpu.gpu.queue.onSubmittedWorkDone()),
      Promise.resolve().then(() => gpu.settled()),
    ]);
    relief.dispose();
    depth.dispose();
  }
}
