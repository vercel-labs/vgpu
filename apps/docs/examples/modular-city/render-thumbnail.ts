import { frame, type Gpu, type Target } from "vgpu";
import { orbitRig } from "vgpu/scene";

import { createCity } from "./city";
import { DEFAULT_POPULATION } from "./layout";
import { createPipeline, HOME_VIEW } from "./pipeline";

interface Options {
  readonly dt?: number;
  readonly time?: number;
  readonly warmupFrames?: number;
}

/** Thumbnail neighborhood (downtown) shown selected and lifted, and the building highlighted in it. */
const THUMB_NEIGHBORHOOD = 6;
const THUMB_LIFT = 1.4;

/** The city only moves with the camera, so one frame of the fixed home view is the thumbnail. */
export async function renderThumbnail(gpu: Gpu, output: Target, _options: Options = {}): Promise<void> {
  try {
    const city = createCity({ population: DEFAULT_POPULATION });
    city.selectNeighborhood(THUMB_NEIGHBORHOOD);
    city.moveNeighborhood(THUMB_NEIGHBORHOOD, { lift: THUMB_LIFT });
    const ids = city.buildingIds(THUMB_NEIGHBORHOOD);
    const tallest = ids.reduce(
      (best, id) => (city.building(id)!.kind === "tower" && (best === 0 || id > best) ? id : best),
      0
    );
    city.select(tallest || ids[0] || 0);

    const pipeline = createPipeline(gpu, city, output.size);
    // Thumbnails are framed for a 720 px tall view; outlines scale with the target height.
    pipeline.resize(output.size, output.size[1] / 720);
    pipeline.updateCamera(orbitRig(HOME_VIEW));
    await frame(gpu, (currentFrame) => {
      pipeline.render(currentFrame, output);
    }).done;
  } finally {
    await Promise.allSettled([
      Promise.resolve().then(() => gpu.gpu.queue.onSubmittedWorkDone()),
      Promise.resolve().then(() => gpu.settled()),
    ]);
  }
}
