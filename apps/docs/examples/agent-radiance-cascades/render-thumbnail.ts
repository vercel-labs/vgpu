import type { Gpu, Target } from "vgpu";

import {
  createScene,
  destroyScene,
  prepareScene,
  presentScene,
  renderLighting,
  scaledSize,
  type AgentRadianceScene,
  type AgentRadianceView,
} from "./simulation";

interface ThumbnailOptions {
  readonly time?: number;
  readonly view?: AgentRadianceView;
}

export async function renderThumbnail(
  gpu: Gpu,
  output: Target,
  options: ThumbnailOptions = {}
): Promise<void> {
  let scene: AgentRadianceScene | undefined;
  let failed = false;
  try {
    scene = createScene(
      gpu,
      scaledSize(output.size[0], output.size[1], 1, 640),
      2
    );
    await prepareScene(scene, output.format);
    const view = options.view ?? "final";
    renderLighting(scene, options.time ?? 1.5, view);
    presentScene(scene, output, view);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    await Promise.allSettled([
      Promise.resolve().then(() => gpu.gpu.queue.onSubmittedWorkDone()),
      Promise.resolve().then(() => gpu.settled()),
    ]);
    try {
      if (scene) destroyScene(scene);
    } catch (error) {
      if (!failed) throw error;
    }
  }
}
