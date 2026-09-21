import { describe, expect, test } from "vitest";

import { shadowCurvePoints, shadowCurveValue } from "./shadow-curve";

describe("shadow curve editor", () => {
  test("preserves the previous gamma transfer at neutral contrast", () => {
    for (const input of [0, 0.1, 0.25, 0.5, 0.9, 1]) {
      expect(shadowCurveValue(input, 2.2, 1, 0.35)).toBeCloseTo(
        Math.pow(input, 2.2),
        10
      );
    }
  });

  test("sharpens values on both sides of the selected pivot", () => {
    expect(shadowCurveValue(0.25, 1, 4, 0.5)).toBeLessThan(0.25);
    expect(shadowCurveValue(0.75, 1, 4, 0.5)).toBeGreaterThan(0.75);
    expect(shadowCurveValue(0, 1, 4, 0.5)).toBe(0);
    expect(shadowCurveValue(1, 1, 4, 0.5)).toBe(1);
  });

  test("generates a complete normalized SVG polyline", () => {
    const points = shadowCurvePoints(2.2, 3, 0.5, 4).split(" ");
    expect(points).toHaveLength(5);
    expect(points[0]).toBe("0.00,100.00");
    expect(points.at(-1)).toBe("100.00,0.00");
  });
});
