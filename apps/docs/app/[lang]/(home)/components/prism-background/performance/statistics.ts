import type { PrismPerformanceSummary } from "./types";

export function summarizePerformance(
  samples: readonly number[]
): PrismPerformanceSummary {
  if (samples.length === 0) {
    return {
      samples: 0,
      min: 0,
      max: 0,
      mean: 0,
      p50: 0,
      p95: 0,
    };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    samples: sorted.length,
    min: sorted[0]!,
    max: sorted.at(-1)!,
    mean: samples.reduce((sum, value) => sum + value, 0) / samples.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
  };
}

function percentile(sorted: readonly number[], position: number): number {
  const index = (sorted.length - 1) * position;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const fraction = index - lower;
  return sorted[lower]! * (1 - fraction) + sorted[upper]! * fraction;
}
