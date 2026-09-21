import { describe, expect, test } from "vitest";

import { darkWallClear, srgbToLinear } from "./clear";

describe("dark wall clear", () => {
  test("matches the shader's piecewise sRGB transfer", () => {
    expect(srgbToLinear(0)).toBe(0);
    expect(srgbToLinear(0.04045)).toBeCloseTo(0.00313080495, 10);
    expect(srgbToLinear(0.5)).toBeCloseTo(0.21404114048, 10);
    expect(srgbToLinear(1)).toBe(1);
  });

  test("converts CSS bytes to linear RGB and keeps an opaque clear", () => {
    const expected = [
      0.005181516702338386,
      0.014443843596092545,
      0.21586050011389926,
      1,
    ];
    darkWallClear("#102080", "glass").forEach((value, channel) =>
      expect(value).toBeCloseTo(expected[channel]!, 15)
    );
    expect(darkWallClear("ffffff", "wall")).toEqual([1, 1, 1, 1]);
  });

  test("uses opaque black for caustic-only and malformed colors", () => {
    expect(darkWallClear("#ffffff", "caustic")).toEqual([0, 0, 0, 1]);
    expect(darkWallClear("transparent", "back")).toEqual([0, 0, 0, 1]);
  });
});
