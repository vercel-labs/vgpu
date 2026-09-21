const TAU = Math.PI * 2;
const DUST_FPS = 30;

export interface PrismPerformanceInput {
  readonly aim: readonly [number, number];
  readonly orbit: readonly [number, number];
}

/**
 * Repeatable Lissajous pointer path. It covers both axes without dwelling on a
 * viewport edge and drives the same lamp/camera state that live pointer input does.
 */
export function deterministicPerformanceInput(
  frame: number,
  cycleFrames: number
): PrismPerformanceInput {
  const phase = (TAU * (frame + 0.25)) / Math.max(1, cycleFrames);
  const x = clamp01(0.5 + Math.sin(phase) * 0.44);
  const y = clamp01(0.5 + Math.sin(phase * 2 + Math.PI / 5) * 0.44);
  return {
    aim: [y, x],
    orbit: [x * 2 - 1, y * 2 - 1],
  };
}

/** Repeatable dust clock: exactly one production dust tick per rendered frame. */
export function deterministicDustTime(frame: number): number {
  return frame / DUST_FPS;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}
