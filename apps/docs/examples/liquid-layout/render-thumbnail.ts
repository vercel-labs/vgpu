// The gallery thumbnail: the live dynamics and pipeline fed by the resting grid
// instead of the DOM. The eight cards pour in, settle, and rest until necks
// have grown between row neighbours; the frame is caught with the edges still
// wobbling. The owning script disposes the Gpu, which releases every resource.

import { frame, type Gpu, type Target } from 'vgpu';

import { CARD_BY_ID } from './cards';
import { createLayoutStore, gridFrame } from './layout-store';
import { type CardSample, createDynamics } from './liquid-dynamics';
import { createPipeline } from './liquid-pipeline';

interface ThumbOptions {
  readonly warmupFrames?: number;
  /** Seconds into the scripted scene. */
  readonly time?: number;
  readonly dt?: number;
}

// The scene is laid out in CSS px at the fullscreen preview size; larger
// targets render the same layout at a higher DPR.
const VIEW = [1280, 720] as const;
const LIGHT = [0.62, 0.2, 380] as const;

function gridSlots(count: number) {
  const grid = gridFrame(VIEW[0], VIEW[1], count);
  const centres = Array.from({ length: count }, (_, i) => [
    grid.left + (i % grid.columns) * (grid.cardWidth + grid.gap) + grid.cardWidth / 2,
    grid.top + Math.floor(i / grid.columns) * (grid.cardHeight + grid.gap) + grid.cardHeight / 2,
  ] as const);
  return { centres, hw: grid.cardWidth / 2, hh: grid.cardHeight / 2 };
}

/** The resting grid in reading order, one sample per card. */
function restingCards(): CardSample[] {
  const { order } = createLayoutStore().getState();
  const { centres, hw, hh } = gridSlots(order.length);
  return order.map((id, slot) => ({
    id,
    layer: 'grid',
    cx: centres[slot]![0],
    cy: centres[slot]![1],
    hw,
    hh,
    rotation: 0,
    offsetX: 0,
    offsetY: 0,
    scale: 1,
    hue: CARD_BY_ID.get(id)?.hue ?? 0,
    present: true,
    hovered: false,
    lifted: false,
  }));
}

export async function renderThumbnail(gpu: Gpu, target: Target, options: ThumbOptions = {}): Promise<void> {
  try {
    const pipeline = createPipeline(gpu, target.size, target.size[0] / VIEW[0]);
    await pipeline.prewarm(target);

    const dt = options.dt ?? 1 / 60;
    const frames = Math.max(1, Math.round(options.warmupFrames ?? 60));
    // The scene always plays from its start; only the last frames are rendered.
    const steps = Math.max(frames, Math.round((options.time ?? 4) / dt));
    const cards = restingCards();
    const dynamics = createDynamics({ smoothness: 1, reducedMotion: false });
    for (let i = 1; i <= steps; i++) {
      const liquid = dynamics.update(cards, dt, VIEW);
      if (i <= steps - frames) continue;
      pipeline.update({ liquid, light: [VIEW[0] * LIGHT[0], VIEW[1] * LIGHT[1], LIGHT[2]], dim: 0 });
      frame(gpu, (currentFrame) => pipeline.encode(currentFrame, target));
    }
  } finally {
    await Promise.allSettled([
      Promise.resolve().then(() => gpu.gpu.queue.onSubmittedWorkDone()),
      Promise.resolve().then(() => gpu.settled()),
    ]);
  }
}
