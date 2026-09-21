import type { Gpu, Target } from "vgpu";

import type { ThumbnailOptions } from "@/lib/example-renderer";
import {
  createScene,
  destroyScene,
  prepareScene,
  presentScene,
  setControls,
  setLampArc,
  setOrbit,
} from "./scene/scene";
import type { PrismControls } from "./types";

export interface PrismThumbnailOptions extends ThumbnailOptions {
  readonly controls?: PrismControls;
  readonly lampArc?: number;
  readonly orbit?: readonly [number, number];
}

/** Deterministic headless frame used by gallery thumbnails and Node GPU tests. */
export async function renderThumbnail(
  gpu: Gpu,
  output: Target,
  options: PrismThumbnailOptions = {}
): Promise<void> {
  const scene = createScene(gpu, output.size, "prism-rainbow-thumb");
  try {
    if (options.controls) setControls(scene, options.controls);
    if (options.lampArc !== undefined) setLampArc(scene, options.lampArc);
    if (options.orbit) setOrbit(scene, options.orbit[0], options.orbit[1]);
    await prepareScene(scene, output);
    presentScene(scene, output);
    await gpu.gpu.queue.onSubmittedWorkDone();
    await gpu.settled();
  } finally {
    destroyScene(scene);
  }
}
