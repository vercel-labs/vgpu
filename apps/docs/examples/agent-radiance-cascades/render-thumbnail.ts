import type { Gpu, Target } from 'vgpu';

import type { ThumbnailOptions } from '../../lib/example-renderer';
import { scaledSize } from './scene-size';
import {
  createScene,
  destroyScene,
  prepareScene,
  presentScene,
  renderLighting,
} from './simulation';
import { AGENT_RADIANCE_QUALITY_SETTINGS, type AgentRadianceView } from './types';

export interface AgentRadianceThumbnailOptions extends ThumbnailOptions {
  readonly view?: AgentRadianceView;
}

export async function renderThumbnail(
  gpu: Gpu,
  output: Target,
  options: AgentRadianceThumbnailOptions = {}
): Promise<void> {
  const quality = AGENT_RADIANCE_QUALITY_SETTINGS.web;
  const size = scaledSize(output.size[0], output.size[1], 1, quality.maxSceneEdge);
  const scene = createScene(gpu, size, 'agent-radiance-thumb', quality.directionBase);
  try {
    await prepareScene(scene, output.format);
    const view = options.view ?? 'final';
    renderLighting(scene, options.time ?? 1.5, view);
    presentScene(scene, output, view);
    await gpu.gpu.queue.onSubmittedWorkDone();
    await gpu.settled();
  } finally {
    destroyScene(scene);
  }
}
