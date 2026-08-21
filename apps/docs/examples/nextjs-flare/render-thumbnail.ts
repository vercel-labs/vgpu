import type { Gpu, Target } from 'vgpu';

import type { ThumbnailOptions } from '../../lib/example-renderer';
import { mapAutonomousLight } from './animation';
import { BAKED_LOGO_HEIGHT, BAKED_LOGO_WIDTH, bakedLogoRgba } from './logo-raster-baked';
import { centeredPlacement } from './placement';
import { FlarePipeline } from './pipeline';
import { DEFAULT_FLARE_SETTINGS } from './settings';
import { createLogoTexture, uploadLogoTextureRgba } from './textures';

export async function renderThumbnail(
  gpu: Gpu,
  target: Target,
  opts: ThumbnailOptions = {}
): Promise<void> {
  const pipeline = new FlarePipeline(gpu, target);
  let logoTexture: GPUTexture | undefined;
  try {
    await pipeline.resize(target.size, 2);
    const [width, height] = target.size;
    const placement = centeredPlacement(width, height, height);
    const rgba = await bakedLogoRgba();
    logoTexture = createLogoTexture(gpu, BAKED_LOGO_WIDTH, BAKED_LOGO_HEIGHT);
    uploadLogoTextureRgba(gpu, logoTexture, rgba, BAKED_LOGO_WIDTH, BAKED_LOGO_HEIGHT);
    pipeline.bindLogoTexture(logoTexture, BAKED_LOGO_WIDTH, BAKED_LOGO_HEIGHT, placement);
    const time = opts.time ?? 4.2;
    const light = mapAutonomousLight(time, placement);
    pipeline.setFrameUniforms(DEFAULT_FLARE_SETTINGS, placement, light, 0, time, 0);
    pipeline.draw(true);
    await gpu.gpu.queue.onSubmittedWorkDone();
  } finally {
    await Promise.allSettled([gpu.settled()]);
    logoTexture?.destroy();
    pipeline.dispose();
  }
}
