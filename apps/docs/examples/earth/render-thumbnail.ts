import type { Gpu, Target } from 'vgpu';
import { frame } from 'vgpu';

import type { ThumbnailOptions } from '../../lib/example-renderer';
import { EARTH_TUNING, sunDegreesAt } from './planet';
import {
  bakeMaps,
  createMaps,
  createScene,
  createTargets,
  destroyMaps,
  destroyScene,
  destroyTargets,
  prewarm,
  render,
  setFrameUniforms,
  setStaticBindings,
} from './scene';

export async function renderThumbnail(
  gpu: Gpu,
  output: Target,
  opts: ThumbnailOptions = {}
): Promise<void> {
  const maps = createMaps(gpu, 'earth-thumb');
  const scene = createScene(gpu, maps, 'earth-thumb');
  const targets = createTargets(gpu, output.size, 'earth-thumb');
  try {
    setStaticBindings(scene, maps, targets);
    await Promise.all([bakeMaps(gpu, maps), prewarm(scene, targets, output)]);
    const { yaw, pitch, radius, sunDegrees } = EARTH_TUNING.poster;
    const dt = opts.dt ?? 1 / 60;
    let time = opts.time ?? 0;
    for (let i = 0; i < Math.max(1, opts.warmupFrames ?? 1); i++) {
      setFrameUniforms(
        scene,
        output,
        { yaw, pitch, radius },
        sunDegrees + sunDegreesAt(time),
        time
      );
      frame(gpu, (currentFrame) => render(currentFrame, scene, targets, output));
      time += dt;
    }
    await gpu.gpu.queue.onSubmittedWorkDone();
    await gpu.settled();
  } finally {
    destroyScene(scene);
    destroyTargets(targets);
    destroyMaps(maps);
  }
}
