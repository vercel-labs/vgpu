import type { Gpu, Target } from 'vgpu';

import type { ThumbnailOptions } from '../../lib/example-renderer';
import { renderThumb, type RadianceCascadesStats } from './validation';

export interface RadianceCascadesThumbnailOptions extends ThumbnailOptions {
  scriptedStroke?: boolean;
  onStateValidated?: (stats: RadianceCascadesStats) => void;
}

export async function renderThumbnail(
  gpu: Gpu,
  target: Target,
  options: RadianceCascadesThumbnailOptions = {}
): Promise<void> {
  await renderThumb(gpu, target, options);
}
