import type { Gpu, Target } from 'vgpu';
import { frame, target } from 'vgpu';

import type { ThumbnailOptions } from '../../lib/example-renderer';
import { createBlit, createScene, renderScene, type InstancedScene } from './scene-pipeline';
import { DEFAULT_INSTANCED_RENDERING_CONTROLS } from './types';

export async function renderThumbnail(
  gpu: Gpu,
  output: Target,
  opts: ThumbnailOptions = {}
): Promise<void> {
  let colorTarget: Target | undefined;
  let scene: InstancedScene | undefined;
  try {
    colorTarget = target(gpu, { size: output.size, format: 'rgba8unorm', depth: true });
    const blit = createBlit(gpu, colorTarget, output);
    scene = await createScene(gpu, colorTarget, DEFAULT_INSTANCED_RENDERING_CONTROLS.count);
    await blit.compile(output);
    let time = opts.time ?? 2.4;
    for (let i = 0; i < (opts.warmupFrames ?? 3); i++) {
      time += opts.dt ?? 1 / 60;
      frame(gpu, (currentFrame) =>
        renderScene(currentFrame, scene!, blit, colorTarget!, output, time)
      );
    }
  } finally {
    await Promise.allSettled([gpu.gpu.queue.onSubmittedWorkDone(), gpu.settled()]);
    scene?.geometry.destroy();
    (colorTarget as (Target & { destroy?: () => void }) | undefined)?.destroy?.();
  }
}
