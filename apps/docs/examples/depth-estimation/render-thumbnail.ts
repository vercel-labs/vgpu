import type { Buffer, Gpu, Target } from "vgpu";
import {
  decodeGoldenColour,
  decodeGoldenDepth,
  GOLDEN_MODEL_ID,
} from "./fixtures";
import {
  createColourBuffer,
  createDepthBuffer,
  createSideBySidePipeline,
  getDepthModel,
  writeColour,
  writeDepth,
  type SideBySidePipeline,
} from "./renderer";

export async function renderThumbnail(gpu: Gpu, target: Target): Promise<void> {
  let view: SideBySidePipeline | undefined;
  let depth: Buffer | undefined;
  let colour: Buffer | undefined;
  let failed = false;
  let failure: unknown;
  try {
    const model = getDepthModel(GOLDEN_MODEL_ID);
    view = createSideBySidePipeline(gpu, "depth-estimation-thumb");
    depth = createDepthBuffer(gpu, model, "depth-estimation-thumb");
    colour = createColourBuffer(gpu, model, "depth-estimation-thumb");
    writeDepth(depth, decodeGoldenDepth());
    writeColour(colour, decodeGoldenColour());
    view.draw(gpu, target, depth, colour, model, { hasResult: true });
  } catch (error) {
    failed = true;
    failure = error;
  }

  const barriers = await Promise.allSettled([
    Promise.resolve().then(() => gpu.gpu.queue.onSubmittedWorkDone()),
    Promise.resolve().then(() => gpu.settled()),
  ]);
  for (const result of barriers) {
    if (result.status === "rejected" && !failed) {
      failed = true;
      failure = result.reason;
    }
  }
  for (const resource of [colour, depth, view]) {
    try {
      resource?.dispose();
    } catch (error) {
      if (!failed) {
        failed = true;
        failure = error;
      }
    }
  }
  if (failed) throw failure;
}
