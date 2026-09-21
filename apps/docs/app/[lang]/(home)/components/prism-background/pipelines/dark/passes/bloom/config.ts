/** Number of half-resolution steps used to represent the halo. */
export const BLOOM_LEVELS = 4;
export const BLOOM_VISIBLE_LEVELS = 3;
export const PARTICLE_LIGHT_FIRST_LEVEL = BLOOM_VISIBLE_LEVELS;
export const PARTICLE_LIGHT_LEVELS = BLOOM_LEVELS - BLOOM_VISIBLE_LEVELS;

/** Wider kernels are inexpensive on the progressively smaller targets. */
export const BLOOM_KERNEL_TAPS = [6, 10, 14, 18] as const;
export const BLOOM_MAX_KERNEL_TAPS = BLOOM_KERNEL_TAPS.at(-1)!;

/** Three visible bloom scales followed by one particle-only light field. */
export const BLOOM_LEVEL_DIVISORS = [2, 4, 8, 16] as const;

/** Near-to-far scale weights for the three levels visible as bloom. */
export const BLOOM_LEVEL_FACTORS = [1, 0.8, 0.55] as const;

/**
 * Symmetric, energy-normalized half-kernel padded for one fixed WGSL layout.
 * The shader samples index zero once and every remaining coefficient twice.
 */
export function bloomKernelWeights(
  tapCount: number,
  capacity = 24
): readonly number[] {
  const count = Math.min(capacity, Math.max(1, Math.floor(tapCount)));
  const sigma = count / 3;
  const weights = Array.from({ length: capacity }, (_, index) =>
    index < count ? Math.exp((-0.5 * index * index) / (sigma * sigma)) : 0
  );
  const total =
    weights[0]! +
    2 * weights.slice(1, count).reduce((sum, weight) => sum + weight, 0);
  return weights.map((weight) => weight / total);
}

/** Maps the public radius range to a stable near-to-far scale blend. */
export function bloomSpread(
  radius: number,
  minimum: number,
  maximum: number
): number {
  if (!Number.isFinite(radius) || !(maximum > minimum)) return 0;
  return Math.min(1, Math.max(0, (radius - minimum) / (maximum - minimum)));
}
