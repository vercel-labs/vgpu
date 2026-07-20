export const GRID_WIDTH = 128;
export const GRID_HEIGHT = 72;
export const FIXED_STEP = 1 / 60;

export function clamp01(value: number): number { return Math.max(0, Math.min(1, value)); }

export function bilerp(a: number, b: number, c: number, d: number, x: number, y: number): number {
  return (a + (b - a) * x) + ((c + (d - c) * x) - (a + (b - a) * x)) * y;
}

export function clampedCell(x: number, y: number): [number, number] {
  return [Math.max(0, Math.min(GRID_WIDTH - 1, x)), Math.max(0, Math.min(GRID_HEIGHT - 1, y))];
}

export function segmentDistance(point: readonly number[], from: readonly number[], to: readonly number[]): number {
  const abx = to[0]! - from[0]!; const aby = to[1]! - from[1]!;
  const length2 = abx * abx + aby * aby;
  const t = Math.max(0, Math.min(1, ((point[0]! - from[0]!) * abx + (point[1]! - from[1]!) * aby) / Math.max(length2, 1e-7)));
  return Math.hypot(point[0]! - (from[0]! + t * abx), point[1]! - (from[1]! + t * aby));
}

export function idleEmitters(step: number): [[number, number], [number, number]] {
  const t = step / 60;
  return [[.5 + .28 * Math.sin(.73 * t), .5 + .22 * Math.sin(1.09 * t + .4)], [.5 + .26 * Math.sin(.61 * t + Math.PI), .5 + .24 * Math.sin(.97 * t + 2.1)]];
}

export function fixedStepCount(accumulator: number, elapsed: number): { steps: number; accumulator: number } {
  let next = accumulator + Math.min(elapsed, 1 / 30); let steps = 0;
  while (next >= FIXED_STEP && steps < 2) { next -= FIXED_STEP; steps++; }
  if (steps === 2) next = 0;
  return { steps, accumulator: next };
}
