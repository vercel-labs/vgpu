import type { Gpu, Target } from "vgpu";

import {
  BAKED_LOGO_HEIGHT,
  BAKED_LOGO_WIDTH,
  bakedLogoRgba,
} from "./logo-raster-baked";
import { FlarePipeline, mapAutonomousLight, rgbaRaster } from "./pipeline";

interface ThumbnailOptions {
  readonly time?: number;
}

export async function renderThumbnail(
  gpu: Gpu,
  output: Target,
  options: ThumbnailOptions = {}
): Promise<void> {
  let pipeline: FlarePipeline | undefined;
  let primary: unknown;
  let failed = false;
  try {
    pipeline = new FlarePipeline(gpu, output);
    const rgba = await bakedLogoRgba();
    const placement = await pipeline.replace(
      output.size,
      2,
      rgbaRaster(rgba, BAKED_LOGO_WIDTH, BAKED_LOGO_HEIGHT)
    );
    if (!placement) throw new Error("Could not prepare the flare thumbnail.");
    const time = options.time ?? 4.2;
    const light = mapAutonomousLight(time, placement);
    pipeline.setFrameUniforms(placement, light, 0, time, 0);
    pipeline.draw(true);
  } catch (error) {
    primary = error;
    failed = true;
  }

  try {
    await waitForGpu(gpu);
  } catch (error) {
    if (!failed) primary = error;
    failed = true;
  }

  try {
    pipeline?.dispose();
  } catch (error) {
    if (!failed) primary = error;
    failed = true;
  }

  if (failed) throw primary;
}

async function waitForGpu(gpu: Gpu): Promise<void> {
  const results = await Promise.allSettled([
    Promise.resolve().then(() => gpu.gpu.queue.onSubmittedWorkDone()),
    Promise.resolve().then(() => gpu.settled()),
  ]);
  const failure = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected"
  );
  if (failure) throw failure.reason;
}
