/** Node-only deterministic thumbnail entry. */
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

export async function renderThumbnail(
  gpu: Gpu,
  target: Target,
  _options: ThumbnailOptions = {}
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
