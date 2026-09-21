import type { Gpu, Target } from "vgpu";

import {
  createScene,
  destroyScene,
  prepareScene,
  presentScene,
  runChain,
  type RadianceScene,
  type RadianceView,
} from "./simulation";

interface RadianceCascadesStats {
  width: number;
  height: number;
  cascades: number;
  atlas: readonly [number, number];
  finite: boolean;
  maxLuma: number;
  meanLuma: number;
  nearTriangleLuma: number;
  cornerLuma: number;
  emitterTexelsBefore: number;
  emitterTexelsAfter: number;
  changedFraction: number;
}

interface ThumbnailOptions {
  warmupFrames?: number;
  scriptedStroke?: boolean;
  view?: RadianceView;
  onStateValidated?: (stats: RadianceCascadesStats) => void;
}

const STROKES = [
  { from: [0.17, 0.74], to: [0.34, 0.42], stroke: 1 },
  { from: [0.72, 0.28], to: [0.87, 0.64], stroke: 2 },
] as const;

export async function renderThumbnail(
  gpu: Gpu,
  output: Target,
  options: ThumbnailOptions = {}
): Promise<void> {
  let scene: RadianceScene | undefined;
  let failed = false;
  try {
    scene = createScene(gpu, output.size);
    await prepareScene(scene, output.format);
    const view = options.view ?? "final";
    runChain(scene, { keepPrevious: false, view });

    const wantsStats =
      Boolean(options.onStateValidated) || Boolean(options.scriptedStroke);
    const emitterTexelsBefore = wantsStats
      ? await countEmitterTexels(gpu, scene, output)
      : 0;
    presentScene(scene, output, view);
    await gpu.gpu.queue.onSubmittedWorkDone();
    const baseline = wantsStats
      ? new Uint8Array(await output.color.read({ mipLevel: 0, region: "all" }))
      : undefined;

    if (options.scriptedStroke) {
      for (const segment of STROKES) runChain(scene, { segment, view });
    }
    const emitterTexelsAfter = wantsStats
      ? await countEmitterTexels(gpu, scene, output)
      : 0;

    const frames = Math.max(1, options.warmupFrames ?? 1);
    for (let index = 0; index < frames; index++) {
      presentScene(scene, output, view);
    }
    await gpu.gpu.queue.onSubmittedWorkDone();
    await gpu.settled();

    if (wantsStats) {
      const pixels = new Uint8Array(await output.color.read({ mipLevel: 0, region: "all" }));
      const stats: RadianceCascadesStats = {
        ...imageStats(pixels, output.size[0], output.size[1]),
        cascades: scene.cascadeCount,
        atlas: scene.atlas,
        emitterTexelsBefore,
        emitterTexelsAfter,
        changedFraction: baseline ? changedFraction(baseline, pixels) : 0,
      };
      if (options.scriptedStroke) assertStats(stats);
      options.onStateValidated?.(stats);
    }
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

async function countEmitterTexels(
  gpu: Gpu,
  scene: RadianceScene,
  output: Target
): Promise<number> {
  presentScene(scene, output, "emitters");
  await gpu.gpu.queue.onSubmittedWorkDone();
  const pixels = new Uint8Array(await output.color.read({ mipLevel: 0, region: "all" }));
  let count = 0;
  for (let index = 0; index < pixels.length; index += 4) {
    if (pixels[index]! + pixels[index + 1]! + pixels[index + 2]! > 24) {
      count++;
    }
  }
  return count;
}

function luma(pixels: Uint8Array, index: number): number {
  return (
    0.2126 * pixels[index]! +
    0.7152 * pixels[index + 1]! +
    0.0722 * pixels[index + 2]!
  );
}

function changedFraction(before: Uint8Array, after: Uint8Array): number {
  let changed = 0;
  for (let index = 0; index < before.length; index += 4) {
    if (Math.abs(luma(before, index) - luma(after, index)) > 2) changed++;
  }
  return changed / (before.length / 4);
}

function imageStats(pixels: Uint8Array, width: number, height: number) {
  let maxLuma = 0;
  let total = 0;
  let nearTotal = 0;
  let nearCount = 0;
  let cornerTotal = 0;
  let cornerCount = 0;
  const centreX = width / 2;
  const centreY = height / 2;
  const inner = Math.min(width, height) * 0.16;
  const outer = Math.min(width, height) * 0.3;
  const cornerBand = Math.min(width, height) * 0.12;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const value = luma(pixels, (y * width + x) * 4);
      maxLuma = Math.max(maxLuma, value);
      total += value;
      const distance = Math.hypot(x + 0.5 - centreX, y + 0.5 - centreY);
      if (distance >= inner && distance <= outer) {
        nearTotal += value;
        nearCount++;
      }
      if (
        (x < cornerBand || x >= width - cornerBand) &&
        (y < cornerBand || y >= height - cornerBand)
      ) {
        cornerTotal += value;
        cornerCount++;
      }
    }
  }
  return {
    width,
    height,
    finite: true,
    maxLuma,
    meanLuma: total / (width * height),
    nearTriangleLuma: nearTotal / nearCount,
    cornerLuma: cornerTotal / cornerCount,
  };
}

function assertStats(stats: RadianceCascadesStats): void {
  if (stats.maxLuma < 120) {
    throw new Error("Radiance Cascades emitter did not light up.");
  }
  if (stats.nearTriangleLuma <= stats.cornerLuma) {
    throw new Error("Radiance Cascades has no visible falloff.");
  }
  if (stats.emitterTexelsAfter <= stats.emitterTexelsBefore) {
    throw new Error("Radiance Cascades scripted strokes painted nothing.");
  }
  if (stats.changedFraction < 0.02) {
    throw new Error(
      "Radiance Cascades scripted strokes changed too few pixels."
    );
  }
}
