import { BLOOM_KERNEL_TAPS } from "./config";

export type BloomBlurAxis = "horizontal" | "vertical";
export type BloomBlurSampling = "raw" | "bilinear-pairs";

export const BLOOM_BLUR_SAMPLING = [
  { horizontal: "bilinear-pairs", vertical: "bilinear-pairs" },
  { horizontal: "raw", vertical: "bilinear-pairs" },
  { horizontal: "raw", vertical: "bilinear-pairs" },
  { horizontal: "bilinear-pairs", vertical: "bilinear-pairs" },
] as const satisfies readonly Record<BloomBlurAxis, BloomBlurSampling>[];

/** Three vec4s keep the largest supported half-kernel naturally aligned. */
export const BLOOM_PAIRED_KERNEL_CAPACITY = 12;

export interface BloomPairedKernel {
  readonly centerWeight: number;
  readonly pairCount: number;
  readonly weights: readonly number[];
  readonly offsets: readonly number[];
}

/**
 * Combines adjacent positive taps for exact reconstruction by linear filtering.
 * A pair at offsets i/i+1 becomes one sample whose fractional coordinate lets
 * the sampler perform the same weighted sum.
 */
export function bloomPairedKernel(
  weights: readonly number[],
  tapCount: number,
  capacity = BLOOM_PAIRED_KERNEL_CAPACITY
): BloomPairedKernel {
  const count = Math.min(weights.length, Math.max(1, Math.floor(tapCount)));
  const pairCount = Math.ceil((count - 1) / 2);
  if (pairCount > capacity) {
    throw new RangeError(`Bloom paired kernel needs ${pairCount} slots.`);
  }

  const pairedWeights = Array<number>(capacity).fill(0);
  const pairedOffsets = Array<number>(capacity).fill(0);
  for (let pair = 0; pair < pairCount; pair++) {
    const first = 1 + pair * 2;
    const second = first + 1;
    const firstWeight = weights[first] ?? 0;
    const secondWeight = second < count ? (weights[second] ?? 0) : 0;
    const combined = firstWeight + secondWeight;
    pairedWeights[pair] = combined;
    pairedOffsets[pair] =
      combined > 0
        ? (first * firstWeight + second * secondWeight) / combined
        : first;
  }

  return {
    centerWeight: weights[0] ?? 0,
    pairCount,
    weights: pairedWeights,
    offsets: pairedOffsets,
  };
}

export function bloomBlurSampleCount(
  level: number,
  axis: BloomBlurAxis
): number {
  const tapCount = BLOOM_KERNEL_TAPS[level] ?? BLOOM_KERNEL_TAPS.at(-1)!;
  return BLOOM_BLUR_SAMPLING[level]?.[axis] === "bilinear-pairs"
    ? 1 + 2 * Math.ceil((tapCount - 1) / 2)
    : 1 + 2 * (tapCount - 1);
}
