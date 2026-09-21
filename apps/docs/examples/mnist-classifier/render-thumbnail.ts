import type { Buffer, Gpu, Target } from "vgpu";
import { createChart, createLogitsBuffer, writeLogits } from "./renderer";

export const GOLDEN_LOGITS = new Float32Array([
  -7.533131, 7.212919, 5.826909, 6.00873, -12.431555, -8.755082, -21.573675,
  29.645443, -8.709205, 1.797541,
]);

export async function renderThumbnail(gpu: Gpu, target: Target): Promise<void> {
  let logits: Buffer | undefined;
  let failure: { error: unknown } | undefined;
  try {
    const chart = createChart(gpu, "mnist-classifier-thumb");
    logits = createLogitsBuffer(gpu, "mnist-classifier-thumb");
    writeLogits(logits, GOLDEN_LOGITS);
    chart(gpu, target, logits, true);
  } catch (error) {
    failure = { error };
  }

  const barriers = await Promise.allSettled([
    Promise.resolve().then(() => gpu.gpu.queue.onSubmittedWorkDone()),
    Promise.resolve().then(() => gpu.settled()),
  ]);
  for (const result of barriers) {
    if (result.status === "rejected") failure ??= { error: result.reason };
  }
  try {
    logits?.dispose();
  } catch (error) {
    failure ??= { error };
  }
  if (failure) throw failure.error;
}
