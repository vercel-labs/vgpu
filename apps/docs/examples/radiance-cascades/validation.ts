import type { Gpu, Target } from 'vgpu';

import type { PaintSegment } from './pointer-input';
import {
  createScene,
  destroyScene,
  prepareScene,
  presentScene,
  runChain,
  runChainStaged,
  type RadianceScene,
} from './simulation';
import type { RadianceView } from './types';

export interface RadianceCascadesStats {
  readonly width: number;
  readonly height: number;
  readonly cascades: number;
  readonly atlas: readonly [number, number];
  readonly finite: boolean;
  readonly maxLuma: number;
  readonly meanLuma: number;
  /** Mean luma of the ring around the triangle: the light has to reach the grid. */
  readonly nearTriangleLuma: number;
  /** Mean luma of the four corners: the falloff has to leave them darker. */
  readonly cornerLuma: number;
  /** Emitter texels before and after the scripted strokes, from the emitters view. */
  readonly emitterTexelsBefore: number;
  readonly emitterTexelsAfter: number;
  /** Pixels the scripted strokes changed in the final image, as a fraction. */
  readonly changedFraction: number;
}

/**
 * The strokes every deterministic render paints.
 *
 * Fixed normalised coordinates and fixed stroke indices: no clock, no randomness, so two
 * runs of the same harness produce identical bytes.
 */
export const SCRIPTED_STROKES: readonly PaintSegment[] = [
  { from: [0.17, 0.74], to: [0.34, 0.42], stroke: 1 },
  { from: [0.72, 0.28], to: [0.87, 0.64], stroke: 2 },
];

export interface ThumbOptions {
  readonly warmupFrames?: number;
  readonly scriptedStroke?: boolean;
  readonly view?: RadianceView;
  readonly onStateValidated?: (stats: RadianceCascadesStats) => void;
}

/**
 * Deterministic headless render: triangle, optional scripted strokes, then the chain.
 *
 * Radiance cascades carry no state between frames — the image is a pure function of the
 * emitter texture — so "warmup" here means re-running the chain, not advancing a
 * simulation, and the result is byte-identical whatever the frame count.
 */
export async function renderThumb(gpu: Gpu, target: Target, options: ThumbOptions = {}): Promise<void> {
  const scene = createScene(gpu, [target.size[0], target.size[1]], 'radiance-cascades-thumb');
  try {
    await prepareScene(scene, target.format);
    const view = options.view ?? 'final';

    // Triangle only. `keepPrevious: false` is exactly what the Clear button does.
    runChain(scene, { keepPrevious: false, view });
    const wantsStats = Boolean(options.onStateValidated) || Boolean(options.scriptedStroke);
    const emitterTexelsBefore = wantsStats ? await countEmitterTexels(gpu, scene, target) : 0;
    presentScene(scene, target, view);
    await gpu.gpu.queue.onSubmittedWorkDone();
    const baseline = wantsStats ? new Uint8Array(await target.read()) : undefined;

    if (options.scriptedStroke) {
      for (const segment of SCRIPTED_STROKES) runChain(scene, { segment, view });
    }
    const emitterTexelsAfter = wantsStats ? await countEmitterTexels(gpu, scene, target) : 0;

    for (let i = 0; i < Math.max(1, options.warmupFrames ?? 1); i++) presentScene(scene, target, view);
    await gpu.gpu.queue.onSubmittedWorkDone();
    await gpu.settled();

    if (wantsStats) {
      const pixels = new Uint8Array(await target.read());
      const stats = {
        ...imageStats(pixels, target.size[0], target.size[1]),
        cascades: scene.cascadeCount,
        atlas: scene.atlas,
        emitterTexelsBefore,
        emitterTexelsAfter,
        changedFraction: baseline ? changedFraction(baseline, pixels) : 0,
      };
      // The assertions live with the stats, not in the thumbnail script, so the same
      // guarantees hold wherever the deterministic render is driven from.
      if (options.scriptedStroke) assertRadianceCascadesStats(stats);
      options.onStateValidated?.(stats);
    }
  } finally {
    try {
      await gpu.gpu.queue.onSubmittedWorkDone();
    } finally {
      destroyScene(scene);
    }
  }
}

/**
 * Renders the scene one pass at a time and hands every intermediate to `onStage`.
 *
 * This is the debug-extraction path: the harness uses it to dump the emitter texture, each
 * jump-flood round, the distance field and every cascade atlas as PNGs.
 */
export async function renderStaged(
  gpu: Gpu,
  size: readonly [number, number],
  onStage: (name: string, target: Target, scene: RadianceScene) => Promise<void> | void,
  options: { readonly scriptedStroke?: boolean; readonly view?: RadianceView; readonly outputFormat?: GPUTextureFormat } = {},
): Promise<RadianceScene> {
  const scene = createScene(gpu, [size[0], size[1]], 'radiance-cascades-staged');
  await prepareScene(scene, options.outputFormat ?? 'rgba8unorm');
  const view = options.view ?? 'final';
  await runChainStaged(scene, { keepPrevious: false, view }, (name, target) => onStage(name, target, scene));
  if (options.scriptedStroke) {
    for (const segment of SCRIPTED_STROKES) {
      await runChainStaged(scene, { segment, view }, (name, target) => onStage(`stroke-${segment.stroke}-${name}`, target, scene));
    }
  }
  return scene;
}

/** Emitter texels visible in the emitters view; the strokes must raise this count. */
async function countEmitterTexels(gpu: Gpu, scene: RadianceScene, scratch: Target): Promise<number> {
  presentScene(scene, scratch, 'emitters');
  await gpu.gpu.queue.onSubmittedWorkDone();
  const pixels = new Uint8Array(await scratch.read());
  let count = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i]! + pixels[i + 1]! + pixels[i + 2]! > 24) count++;
  }
  return count;
}

function luma(pixels: Uint8Array, index: number): number {
  return 0.2126 * pixels[index]! + 0.7152 * pixels[index + 1]! + 0.0722 * pixels[index + 2]!;
}

function changedFraction(before: Uint8Array, after: Uint8Array): number {
  let changed = 0;
  for (let i = 0; i < before.length; i += 4) {
    if (Math.abs(luma(before, i) - luma(after, i)) > 2) changed++;
  }
  return changed / (before.length / 4);
}

function imageStats(pixels: Uint8Array, width: number, height: number) {
  let maxLuma = 0;
  let total = 0;
  let finite = true;
  let nearTotal = 0;
  let nearCount = 0;
  let cornerTotal = 0;
  let cornerCount = 0;
  // A ring around the triangle: close enough to be lit, far enough not to be the emitter.
  const centreX = width / 2;
  const centreY = height / 2;
  const inner = Math.min(width, height) * 0.16;
  const outer = Math.min(width, height) * 0.3;
  const cornerBand = Math.min(width, height) * 0.12;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = (y * width + x) * 4;
      const value = luma(pixels, index);
      finite &&= Number.isFinite(value);
      maxLuma = Math.max(maxLuma, value);
      total += value;
      const distance = Math.hypot(x + 0.5 - centreX, y + 0.5 - centreY);
      if (distance >= inner && distance <= outer) { nearTotal += value; nearCount++; }
      if ((x < cornerBand || x >= width - cornerBand) && (y < cornerBand || y >= height - cornerBand)) {
        cornerTotal += value;
        cornerCount++;
      }
    }
  }

  return {
    width,
    height,
    finite,
    maxLuma,
    meanLuma: total / (width * height),
    nearTriangleLuma: nearCount ? nearTotal / nearCount : 0,
    cornerLuma: cornerCount ? cornerTotal / cornerCount : 0,
  };
}

/** Thrown by the thumbnail script when a render stops looking like this example. */
export function assertRadianceCascadesStats(stats: RadianceCascadesStats): void {
  if (!stats.finite) throw new Error('radiance-cascades produced non-finite pixels.');
  if (stats.maxLuma < 120) throw new Error(`radiance-cascades emitter never lit up: maxLuma ${stats.maxLuma.toFixed(1)} < 120.`);
  if (stats.nearTriangleLuma <= stats.cornerLuma) {
    throw new Error(
      `radiance-cascades has no falloff: ring luma ${stats.nearTriangleLuma.toFixed(2)} <= corner luma ${stats.cornerLuma.toFixed(2)}.`,
    );
  }
  if (stats.emitterTexelsAfter <= stats.emitterTexelsBefore) {
    throw new Error(
      `radiance-cascades scripted strokes painted nothing: ${stats.emitterTexelsBefore} -> ${stats.emitterTexelsAfter} emitter texels.`,
    );
  }
  if (stats.changedFraction < 0.02) {
    throw new Error(`radiance-cascades scripted strokes changed only ${(stats.changedFraction * 100).toFixed(2)}% of pixels; need >=2%.`);
  }
}
