import { describe, expect, test } from "vitest";

import {
  BLOOM_BLUR_SAMPLING,
  BLOOM_PAIRED_KERNEL_CAPACITY,
  bloomBlurSampleCount,
  bloomPairedKernel,
} from "./pairing";
import {
  BLOOM_KERNEL_TAPS,
  BLOOM_LEVEL_DIVISORS,
  bloomKernelWeights,
} from "./config";
import { bloomBlurUniforms } from "./uniforms";

const AXES = ["horizontal", "vertical"] as const;

describe("bilinear Gaussian tap pairing", () => {
  test.each(BLOOM_KERNEL_TAPS)(
    "reconstructs every coefficient of the %i-tap half-kernel",
    (tapCount) => {
      const original = bloomKernelWeights(tapCount);
      const paired = bloomPairedKernel(original, tapCount);
      const reconstructed = reconstructHalfKernel(paired, tapCount);

      expect(paired.pairCount).toBe(Math.ceil((tapCount - 1) / 2));
      expect(paired.weights).toHaveLength(BLOOM_PAIRED_KERNEL_CAPACITY);
      expect(paired.offsets).toHaveLength(BLOOM_PAIRED_KERNEL_CAPACITY);
      reconstructed.forEach((weight, index) =>
        expect(weight).toBeCloseTo(original[index]!, 14)
      );
    }
  );

  test("routes pairing only through passes with matching texel grids", () => {
    expect(BLOOM_BLUR_SAMPLING).toEqual([
      { horizontal: "bilinear-pairs", vertical: "bilinear-pairs" },
      { horizontal: "raw", vertical: "bilinear-pairs" },
      { horizontal: "raw", vertical: "bilinear-pairs" },
      { horizontal: "bilinear-pairs", vertical: "bilinear-pairs" },
    ]);

    for (const [level, routing] of BLOOM_BLUR_SAMPLING.entries()) {
      for (const axis of AXES) {
        const uniforms = bloomBlurUniforms(level, axis, [144, 90]);
        expect("kernel" in uniforms).toBe(
          routing[axis] === "bilinear-pairs"
        );
        expect("tapCount" in uniforms).toBe(routing[axis] === "raw");
      }
    }
  });

  test("reduces the 1440x900 blur workload by exactly 31.28 percent", () => {
    let rawSamples = 0;
    let pairedSamples = 0;
    for (const [level, divisor] of BLOOM_LEVEL_DIVISORS.entries()) {
      const pixels = Math.ceil(1440 / divisor) * Math.ceil(900 / divisor);
      const rawPerPass = 1 + 2 * (BLOOM_KERNEL_TAPS[level]! - 1);
      for (const axis of AXES) {
        rawSamples += pixels * rawPerPass;
        pairedSamples += pixels * bloomBlurSampleCount(level, axis);
      }
    }

    expect(rawSamples).toBe(11_663_460);
    expect(pairedSamples).toBe(8_015_220);
    expect(rawSamples - pairedSamples).toBe(3_648_240);
    expect((100 * (rawSamples - pairedSamples)) / rawSamples).toBeCloseTo(
      31.28,
      2
    );
  });
});

function reconstructHalfKernel(
  paired: ReturnType<typeof bloomPairedKernel>,
  tapCount: number
): number[] {
  const result = Array<number>(tapCount).fill(0);
  result[0] = paired.centerWeight;
  for (let pair = 0; pair < paired.pairCount; pair++) {
    const offset = paired.offsets[pair]!;
    const lower = Math.floor(offset);
    const blend = offset - lower;
    result[lower]! += paired.weights[pair]! * (1 - blend);
    if (lower + 1 < tapCount) {
      result[lower + 1]! += paired.weights[pair]! * blend;
    }
  }
  return result;
}
