import type { Gpu, Target } from 'vgpu';

import type { ThumbnailOptions } from '../../lib/example-renderer';
import { createFixtureDigit, GOLDEN_LOGITS } from './fixtures';
import {
  createDigitBuffer,
  createIdleLogitsBuffer,
  createVisualizer,
  writeDigit,
  writeLogits,
} from './renderer';

/** Deterministic, ORT-free render of the seeded digit and golden logits. */
export async function renderThumbnail(
  gpu: Gpu,
  target: Target,
  _options: ThumbnailOptions = {}
): Promise<void> {
  const visualizer = createVisualizer(gpu, 'mnist-classifier-thumb');
  const digit = createDigitBuffer(gpu, 'mnist-classifier-thumb');
  const logits = createIdleLogitsBuffer(gpu, 'mnist-classifier-thumb');
  try {
    writeDigit(digit, createFixtureDigit());
    writeLogits(logits, GOLDEN_LOGITS);
    visualizer.render(gpu, target, logits, digit, true);
  } finally {
    await Promise.allSettled([
      Promise.resolve().then(() => gpu.gpu.queue.onSubmittedWorkDone()),
      Promise.resolve().then(() => gpu.settled()),
    ]);
    visualizer.dispose();
    logits.dispose();
    digit.dispose();
  }
}
