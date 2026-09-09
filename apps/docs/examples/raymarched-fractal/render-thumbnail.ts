import { frame } from "vgpu";
import type { Gpu, Target } from "vgpu";

import {
  compileScene,
  createScene,
  destroyScene,
  POSTER,
  renderScene,
  type FractalScene,
  type Orbit,
} from "./pipeline";

type Variant = "static-repeat" | "alternate-orbit" | "bloom-off";

interface ThumbnailOptions {
  readonly warmupFrames?: number;
  readonly time?: number;
  readonly dt?: number;
  readonly onVariantRendered?: (
    variant: Variant,
    pixels: Uint8Array,
    size: readonly [number, number]
  ) => void | Promise<void>;
}

const ALTERNATE: Readonly<Orbit> = { yaw: -0.35, pitch: 0.1 };

export async function renderThumbnail(
  gpu: Gpu,
  output: Target,
  options: ThumbnailOptions = {}
): Promise<void> {
  let scene: FractalScene | undefined;
  let primaryError: unknown;
  let failed = false;
  try {
    scene = createScene(gpu, output.size);
    await compileScene(scene, output);
    await renderAndWait(gpu, scene, output, POSTER);
    await renderAndWait(gpu, scene, output, POSTER);
    await reportVariant(options, "static-repeat", output);
    await renderAndWait(gpu, scene, output, ALTERNATE);
    await reportVariant(options, "alternate-orbit", output);
    scene.effects.composite.set({ composite: { bloomStrength: 0 } });
    await renderAndWait(gpu, scene, output, POSTER);
    await reportVariant(options, "bloom-off", output);
    scene.effects.composite.set({ composite: { bloomStrength: 0.65 } });
    await renderAndWait(gpu, scene, output, POSTER);
  } catch (error) {
    primaryError = error;
    failed = true;
  }

  const barriers = await Promise.allSettled([
    Promise.resolve().then(() => gpu.gpu.queue.onSubmittedWorkDone()),
    Promise.resolve().then(() => gpu.settled()),
  ]);
  const rejectedBarrier = barriers.find(
    (result): result is PromiseRejectedResult => result.status === "rejected"
  );
  let cleanupError: unknown;
  let cleanupFailed = false;
  try {
    if (scene) destroyScene(scene);
  } catch (error) {
    cleanupError = error;
    cleanupFailed = true;
  }

  if (failed) throw primaryError;
  if (rejectedBarrier) throw rejectedBarrier.reason;
  if (cleanupFailed) throw cleanupError;
}

async function renderAndWait(
  gpu: Gpu,
  scene: FractalScene,
  output: Target,
  orbit: Readonly<Orbit>
): Promise<void> {
  frame(gpu, (currentFrame) => renderScene(currentFrame, scene, output, orbit));
  await Promise.resolve().then(() => gpu.gpu.queue.onSubmittedWorkDone());
}

async function reportVariant(
  options: ThumbnailOptions,
  variant: Variant,
  output: Target
): Promise<void> {
  if (!options.onVariantRendered) return;
  const pixels = await output.color.read({ mipLevel: 0, region: "all" });
  await options.onVariantRendered(variant, new Uint8Array(pixels), output.size);
}
