import { describe, expect, test } from "vitest";

import {
  BLOOM_KERNEL_TAPS,
  BLOOM_LEVEL_DIVISORS,
  BLOOM_LEVELS,
  BLOOM_LEVEL_FACTORS,
  BLOOM_VISIBLE_LEVELS,
  PARTICLE_LIGHT_FIRST_LEVEL,
  PARTICLE_LIGHT_LEVELS,
  bloomKernelWeights,
  bloomSpread,
} from "./config";

describe("multiscale bloom", () => {
  test("uses one progressively wider kernel per level", () => {
    expect(BLOOM_KERNEL_TAPS).toHaveLength(BLOOM_LEVELS);
    expect(BLOOM_LEVEL_FACTORS).toHaveLength(BLOOM_VISIBLE_LEVELS);
    expect(BLOOM_KERNEL_TAPS).toEqual([6, 10, 14, 18]);
    expect(BLOOM_LEVEL_DIVISORS).toEqual([2, 4, 8, 16]);
  });

  test("reserves only the 1/16 level for particle illumination", () => {
    expect(BLOOM_VISIBLE_LEVELS).toBe(3);
    expect(PARTICLE_LIGHT_FIRST_LEVEL).toBe(3);
    expect(PARTICLE_LIGHT_LEVELS).toBe(1);
    expect(BLOOM_VISIBLE_LEVELS + PARTICLE_LIGHT_LEVELS).toBe(BLOOM_LEVELS);
  });

  test.each(BLOOM_KERNEL_TAPS)(
    "normalizes the symmetric %i-tap half-kernel",
    (tapCount) => {
      const weights = bloomKernelWeights(tapCount);
      const energy =
        weights[0]! +
        2 * weights.slice(1).reduce((sum, weight) => sum + weight, 0);
      expect(weights).toHaveLength(24);
      expect(energy).toBeCloseTo(1, 12);
      expect(weights.slice(tapCount).every((weight) => weight === 0)).toBe(
        true
      );
    }
  );

  test("maps radius to the scale blend and clamps its margins", () => {
    expect(bloomSpread(-10, 0.25, 3)).toBe(0);
    expect(bloomSpread(0.25, 0.25, 3)).toBe(0);
    expect(bloomSpread(1.625, 0.25, 3)).toBeCloseTo(0.5);
    expect(bloomSpread(3, 0.25, 3)).toBe(1);
    expect(bloomSpread(10, 0.25, 3)).toBe(1);
  });
});
