import type { Gpu, Target } from 'vgpu';
import { frame } from 'vgpu';

import type { ThumbnailOptions } from '../../lib/example-renderer';
import {
  createScene,
  destroyScene,
  FRAME_SIZE,
  renderScene,
  SPIN_RATE,
  uploadTestPattern,
} from './scene';

/**
 * Three-quarter view, so the thumbnail reads as a cube rather than a flat picture.
 * Stated as the pose it wants and converted to a time, so the spin rate and the
 * thumbnail cannot drift apart.
 */
const POSE = 0.405;

/**
 * The Node path has no video decoder, so it uploads the same test pattern the browser
 * shows before its first decoded frame. Everything but the source of the bytes is the
 * production path.
 */
export async function renderThumbnail(
  gpu: Gpu,
  target: Target,
  options: ThumbnailOptions = {},
): Promise<void> {
  const scene = createScene(gpu, FRAME_SIZE);
  try {
    uploadTestPattern(gpu, scene);
    frame(gpu, (currentFrame) =>
      renderScene(currentFrame, scene, target, options.time ?? POSE / SPIN_RATE),
    );
  } finally {
    await Promise.allSettled([
      Promise.resolve().then(() => gpu.gpu.queue.onSubmittedWorkDone()),
      Promise.resolve().then(() => gpu.settled()),
    ]);
    destroyScene(scene);
  }
}
