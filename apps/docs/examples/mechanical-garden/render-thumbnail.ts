import { frame, type Gpu, type Target } from "vgpu";
import { orbitRig } from "vgpu/scene";

import { VIEWS } from "./camera";
import { createColony, DEFAULT_PRESET, DEFAULT_SEED, PRESETS, setDestination, step } from "./colony";
import { createPipeline } from "./pipeline";

interface Options {
  readonly dt?: number;
  readonly time?: number;
  readonly warmupFrames?: number;
}

/** Fixed simulation steps before the shot: the colony is mid-stride on its way to a destination. */
export const THUMB_STEPS = 330;
const THUMB_DESTINATION = [1.6, 1.2] as const;
/** A mound raised under the walkers during the first steps, so the shot shows sculpted terrain. */
const THUMB_MOUND = { x: -0.8, z: 0.6, steps: 90 } as const;

/**
 * The simulation is CPU-side and deterministic (fixed steps from a seed), so the thumbnail steps
 * it to a fixed moment and renders one frame of the colony view.
 */
export async function renderThumbnail(gpu: Gpu, output: Target, _options: Options = {}): Promise<void> {
  try {
    const colony = createColony({ seed: DEFAULT_SEED, count: PRESETS[DEFAULT_PRESET].count });
    setDestination(colony, THUMB_DESTINATION[0], THUMB_DESTINATION[1]);
    Object.assign(colony.brush, { active: true, mode: "elevate", x: THUMB_MOUND.x, z: THUMB_MOUND.z, radius: 1.2, strength: 0.45 });
    for (let index = 0; index < THUMB_STEPS; index++) {
      if (index === THUMB_MOUND.steps) colony.brush.active = false;
      step(colony);
    }

    const pipeline = createPipeline(gpu, colony, output.size);
    // Thumbnails are framed for a 720 px tall view; debug widths scale with the target height.
    pipeline.resize(output.size, output.size[1] / 720);
    pipeline.updateCamera(orbitRig(VIEWS[DEFAULT_PRESET]));
    await frame(gpu, (currentFrame) => {
      pipeline.render(currentFrame, output, { time: colony.time, brush: [0, 0, 1, 0], debug: false });
    }).done;
  } finally {
    await Promise.allSettled([
      Promise.resolve().then(() => gpu.gpu.queue.onSubmittedWorkDone()),
      Promise.resolve().then(() => gpu.settled()),
    ]);
  }
}
