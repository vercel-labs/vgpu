import {
  BLOOM_BLUR_SAMPLING,
  bloomPairedKernel,
  type BloomBlurAxis,
} from "./pairing";
import { BLOOM_KERNEL_TAPS, bloomKernelWeights } from "./config";

const KERNEL_WEIGHTS = BLOOM_KERNEL_TAPS.map((count) =>
  bloomKernelWeights(count)
);
const PAIRED_KERNELS = KERNEL_WEIGHTS.map((weights, level) =>
  bloomPairedKernel(weights, BLOOM_KERNEL_TAPS[level]!)
);

export function bloomBlurUniforms(
  level: number,
  axis: BloomBlurAxis,
  size: readonly [number, number]
): Record<string, unknown> {
  const direction = axis === "horizontal" ? [1, 0] : [0, 1];
  const common = {
    direction,
    texelSize: [1 / size[0], 1 / size[1]],
  };
  if (BLOOM_BLUR_SAMPLING[level]?.[axis] === "bilinear-pairs") {
    const paired = PAIRED_KERNELS[level]!;
    return {
      ...common,
      kernel: [paired.centerWeight, paired.pairCount, 0, 0],
      weights0: paired.weights.slice(0, 4),
      weights1: paired.weights.slice(4, 8),
      weights2: paired.weights.slice(8, 12),
      offsets0: paired.offsets.slice(0, 4),
      offsets1: paired.offsets.slice(4, 8),
      offsets2: paired.offsets.slice(8, 12),
    };
  }

  const coefficients = KERNEL_WEIGHTS[level]!;
  return {
    ...common,
    tapCount: BLOOM_KERNEL_TAPS[level]!,
    coefficients0: coefficients.slice(0, 4),
    coefficients1: coefficients.slice(4, 8),
    coefficients2: coefficients.slice(8, 12),
    coefficients3: coefficients.slice(12, 16),
    coefficients4: coefficients.slice(16, 20),
    coefficients5: coefficients.slice(20, 24),
  };
}
