// The gallery thumbnail: the live dynamics and pipeline fed by a scripted scene
// instead of the DOM. The eight cards pour into the grid, rest, and then take
// the autoplay's first shuffle on the layout spring; the frame is caught in
// flight, while passing cards bridge. The owning script disposes the Gpu, which
// releases every resource.

import { frame, type Gpu, type Target } from 'vgpu';

import { CARD_BY_ID } from './cards';
import { createLayoutStore, DEFAULT_SPRING, gridLayout } from './layout-store';
import { createDynamics, type CardSample } from './liquid-dynamics';
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
// Mirrors the live frame: side padding, header and footer hint.
const PAD_X = 44;
const TOP = 76;
const BOTTOM = 60;
// Seconds before the captured frame that the shuffle starts.
const IN_FLIGHT = 0.25;
const LIGHT = [0.62, 0.2, 380] as const;

interface CardState {
  readonly id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
}

function gridSlots(count: number) {
  const areaWidth = VIEW[0] - PAD_X * 2;
  const areaHeight = VIEW[1] - TOP - BOTTOM;
  const layout = gridLayout(areaWidth, areaHeight, count);
  const left = PAD_X + (areaWidth - layout.width) / 2;
  const top = TOP + (areaHeight - layout.height) / 2;
  const centres = Array.from({ length: count }, (_, i) => [
    left + (i % layout.columns) * (layout.cardWidth + layout.gap) + layout.cardWidth / 2,
    top + Math.floor(i / layout.columns) * (layout.cardHeight + layout.gap) + layout.cardHeight / 2,
  ] as const);
  return { centres, hw: layout.cardWidth / 2, hh: layout.cardHeight / 2 };
}

function createScene(shuffleAt: number) {
  // The live store with its default seed: the same permutation the autoplay opens with.
  const store = createLayoutStore();
  const { centres, hw, hh } = gridSlots(store.getState().order.length);
  const cards = new Map<string, CardState>(
    store.getState().order.map((id, slot) => [id, { id, x: centres[slot]![0], y: centres[slot]![1], vx: 0, vy: 0 }]),
  );
  let shuffled = false;

  return (time: number, dt: number): CardSample[] => {
    if (!shuffled && time >= shuffleAt) {
      shuffled = true;
      store.shuffle();
    }
    const { order } = store.getState();
    return order.map((id, slot) => {
      const card = cards.get(id)!;
      // The layout spring Motion runs for a FLIP move, per axis.
      const [tx, ty] = centres[slot]!;
      card.vx += (-DEFAULT_SPRING.stiffness * (card.x - tx) - DEFAULT_SPRING.damping * card.vx) * dt;
      card.vy += (-DEFAULT_SPRING.stiffness * (card.y - ty) - DEFAULT_SPRING.damping * card.vy) * dt;
      card.x += card.vx * dt;
      card.y += card.vy * dt;
      return {
        id,
        layer: 'grid',
        cx: card.x,
        cy: card.y,
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
      };
    });
  };
}

export async function renderThumbnail(gpu: Gpu, target: Target, options: ThumbOptions = {}): Promise<void> {
  try {
    const pipeline = createPipeline(gpu, target.size, target.size[0] / VIEW[0]);
    await pipeline.prewarm(target);

    const dt = options.dt ?? 1 / 60;
    const frames = Math.max(1, Math.round(options.warmupFrames ?? 60));
    // The scene always plays from its start; only the last frames are rendered.
    const steps = Math.max(frames, Math.round((options.time ?? 4) / dt));
    const scene = createScene(steps * dt - IN_FLIGHT);
    const dynamics = createDynamics({ smoothness: 1, reducedMotion: false });
    for (let i = 1; i <= steps; i++) {
      const time = i * dt;
      const liquid = dynamics.update(scene(time, dt), dt, VIEW);
      if (i <= steps - frames) continue;
      pipeline.update({
        time,
        liquid,
        light: [VIEW[0] * LIGHT[0], VIEW[1] * LIGHT[1], LIGHT[2]],
        dim: 0,
        causticSpeed: 0.35,
      });
      frame(gpu, (currentFrame) => pipeline.encode(currentFrame, target));
    }
  } finally {
    await Promise.allSettled([
      Promise.resolve().then(() => gpu.gpu.queue.onSubmittedWorkDone()),
      Promise.resolve().then(() => gpu.settled()),
    ]);
  }
}
