import type { Gpu, Target } from "vgpu";

import { renderThumb, type ThumbOptions } from "./renderer";

export async function renderThumbnail(
  gpu: Gpu,
  output: Target,
  options: ThumbOptions = {}
): Promise<void> {
  await renderThumb(gpu, output, options);
}
