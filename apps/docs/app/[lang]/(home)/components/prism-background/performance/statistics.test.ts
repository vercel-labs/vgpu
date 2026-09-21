import { describe, expect, test } from "vitest";

import { deterministicPerformanceInput } from "./path";
import { summarizePerformance } from "./statistics";

describe("prism performance utilities", () => {
  test("summarizes samples with interpolated percentiles", () => {
    expect(summarizePerformance([4, 1, 3, 2])).toEqual({
      samples: 4,
      min: 1,
      max: 4,
      mean: 2.5,
      p50: 2.5,
      p95: 3.8499999999999996,
    });
    expect(summarizePerformance([])).toEqual({
      samples: 0,
      min: 0,
      max: 0,
      mean: 0,
      p50: 0,
      p95: 0,
    });
  });

  test("uses a bounded, repeatable pointer cycle", () => {
    const cycle = 120;
    for (let frame = 0; frame < cycle; frame += 1) {
      const input = deterministicPerformanceInput(frame, cycle);
      expect(input.aim[0]).toBeGreaterThanOrEqual(0);
      expect(input.aim[0]).toBeLessThanOrEqual(1);
      expect(input.aim[1]).toBeGreaterThanOrEqual(0);
      expect(input.aim[1]).toBeLessThanOrEqual(1);
    }
    const start = deterministicPerformanceInput(7, cycle);
    const repeated = deterministicPerformanceInput(7 + cycle, cycle);
    expect(repeated.aim[0]).toBeCloseTo(start.aim[0], 12);
    expect(repeated.aim[1]).toBeCloseTo(start.aim[1], 12);
    expect(repeated.orbit[0]).toBeCloseTo(start.orbit[0], 12);
    expect(repeated.orbit[1]).toBeCloseTo(start.orbit[1], 12);
  });
});
