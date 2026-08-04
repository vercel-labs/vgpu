/**
 * Node-only thumbnail entry.
 *
 * Kept separate from `renderer.ts` on purpose: the committed depth fixture is
 * 580 KB of base64 with the colour half and the browser has no use for it, so importing it from a
 * module the example bundle pulls in would put it on the wire for every
 * visitor. Only `scripts/render-example-thumbs.mjs` imports this file.
 */
import type { Gpu, Target } from 'vgpu';
import type { ThumbnailOptions } from '../../lib/example-renderer';
import { decodeGoldenColour, decodeGoldenDepth, GOLDEN_MODEL_ID } from './fixtures';
import { getDepthModel } from './model-contract';
import {
  createColourBuffer,
  createDepthBuffer,
  createSideBySidePipeline,
  writeColour,
  writeDepth,
} from './renderer';

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
  const view = createSideBySidePipeline(gpu, 'depth-estimation-thumb');
  const depth = createDepthBuffer(gpu, model, 'depth-estimation-thumb');
  const colour = createColourBuffer(gpu, model, 'depth-estimation-thumb');
  try {
    writeDepth(depth, decodeGoldenDepth());
    writeColour(colour, decodeGoldenColour());
    view.draw(gpu, target, depth, colour, model, { hasResult: true });
  } finally {
    await Promise.allSettled([
      Promise.resolve().then(() => gpu.gpu.queue.onSubmittedWorkDone()),
      Promise.resolve().then(() => gpu.settled()),
    ]);
    view.dispose();
    depth.dispose();
    colour.dispose();
  }
}
