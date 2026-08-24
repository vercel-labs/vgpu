// The approved dark-mode rim blur sigma from the marketing hero.
export const DEFAULT_BLUR_SIGMA = 5;
export const MAX_BLUR_TAPS = 8;

const LEGACY_BLUR_SIGMA = 1.8;

export type BlurTap = Readonly<{ offset: number; weight: number }>;

export type BlurKernel = Readonly<{
  centerWeight: number;
  taps: readonly BlurTap[];
}>;

const LEGACY_DISCRETE_WEIGHTS = [
  0.227027027, 0.1945945946, 0.1216216216, 0.0540540541, 0.0162162162,
] as const;

export function gaussianBlurKernel(inputSigma: number): BlurKernel {
  const sigma = Math.min(12, Math.max(1, inputSigma));
  // The approved 9-tap kernel is a truncated Gaussian whose per-tap inferred
  // sigma averages to 1.8px. Preserve its exact coefficients at that sigma.
  const discreteWeights =
    Math.abs(sigma - LEGACY_BLUR_SIGMA) < 0.000_001
      ? [...LEGACY_DISCRETE_WEIGHTS]
      : gaussianWeights(sigma);
  const centerWeight = discreteWeights[0] ?? 1;
  const taps: BlurTap[] = [];
  for (let index = 1; index < discreteWeights.length; index += 2) {
    const firstWeight = discreteWeights[index] ?? 0;
    const secondWeight = discreteWeights[index + 1] ?? 0;
    const weight = firstWeight + secondWeight;
    if (!weight) continue;
    taps.push({
      offset: (index * firstWeight + (index + 1) * secondWeight) / weight,
      weight,
    });
  }
  return { centerWeight, taps };
}

function gaussianWeights(sigma: number): number[] {
  const radius = Math.min(MAX_BLUR_TAPS * 2, Math.ceil(sigma * 3));
  const weights = Array.from({ length: radius + 1 }, (_, index) =>
    Math.exp(-(index * index) / (2 * sigma * sigma)),
  );
  const total =
    (weights[0] ?? 0) +
    2 * weights.slice(1).reduce((sum, weight) => sum + weight, 0);
  return weights.map((weight) => weight / total);
}
