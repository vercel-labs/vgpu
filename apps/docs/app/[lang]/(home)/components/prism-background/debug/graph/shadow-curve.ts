export function shadowCurveValue(
  input: number,
  gamma: number,
  contrast: number,
  pivot: number
): number {
  const linear = Math.pow(clamp01(input), Math.max(gamma, 0.001));
  const safePivot = Math.min(Math.max(pivot, 0.001), 0.999);
  const safeContrast = Math.max(contrast, 0.001);
  if (linear < safePivot) {
    return safePivot * Math.pow(linear / safePivot, safeContrast);
  }
  return (
    1 - (1 - safePivot) * Math.pow((1 - linear) / (1 - safePivot), safeContrast)
  );
}

export function shadowCurvePoints(
  gamma: number,
  contrast: number,
  pivot: number,
  samples = 48
): string {
  const count = Math.max(Math.round(samples), 2);
  return Array.from({ length: count + 1 }, (_, index) => {
    const input = index / count;
    const output = shadowCurveValue(input, gamma, contrast, pivot);
    return `${(input * 100).toFixed(2)},${((1 - output) * 100).toFixed(2)}`;
  }).join(" ");
}

function clamp01(value: number): number {
  return Math.min(Math.max(value, 0), 1);
}
