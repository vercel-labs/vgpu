import type { Gpu, Target } from 'vgpu';
import { frame } from 'vgpu';
import { perspectiveCamera } from 'vgpu/scene';

import type { ThumbnailOptions } from '../../lib/example-renderer';
import { OCEAN_CAMERA, oceanApi, oceanShaders } from './pipeline';
import { buildOcean } from './scene';

export async function renderThumbnail(
  gpu: Gpu,
  output: Target,
  opts: ThumbnailOptions = {}
): Promise<void> {
  try {
    const scene = buildOcean(gpu, oceanApi, oceanShaders, { size: output.size });
    const camera = perspectiveCamera({
      fov: OCEAN_CAMERA.fov,
      aspect: output.size[0] / output.size[1],
      near: OCEAN_CAMERA.near,
      far: OCEAN_CAMERA.far,
      position: OCEAN_CAMERA.position,
      target: OCEAN_CAMERA.target,
    });

    const dt = opts.dt ?? 1 / 60;
    const warmup = Math.max(0, opts.warmupFrames ?? 0);
    for (let i = 0; i < warmup; i++) scene.simulate(dt);
    scene.simulate((opts.time ?? 9) - warmup * dt);
    scene.updateCamera(camera.viewProjection, camera.worldPosition);

    frame(gpu, (currentFrame) => {
      currentFrame.pass({ target: scene.hdr, clear: scene.clear }, (pass) => {
        pass.draw(scene.skydome);
        pass.draw(scene.ocean);
      });
      currentFrame.pass(output, scene.composite);
    });
  } finally {
    await Promise.allSettled([
      Promise.resolve().then(() => gpu.gpu.queue.onSubmittedWorkDone()),
      Promise.resolve().then(() => gpu.settled()),
    ]);
  }
}
