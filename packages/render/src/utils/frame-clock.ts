export interface FrameClock {
  now(): number;
  delta(): number;
  reset(): void;
  pause(): void;
  resume(): void;
  readonly isPaused: boolean;
}

export function frameClock(): FrameClock {
  let startTime = performance.now();
  let lastDeltaTime = startTime;
  let pausedAt = 0;
  let accumulatedPause = 0;
  let paused = false;

  const activeNow = (): number => {
    const current = performance.now();
    const pendingPause = paused ? current - pausedAt : 0;
    return current - startTime - accumulatedPause - pendingPause;
  };

  return Object.freeze({
    now: () => activeNow() / 1000,
    delta: () => {
      if (paused) return 0;
      const current = performance.now();
      const value = (current - lastDeltaTime) / 1000;
      lastDeltaTime = current;
      return value;
    },
    reset: () => {
      startTime = performance.now();
      lastDeltaTime = startTime;
      pausedAt = 0;
      accumulatedPause = 0;
      paused = false;
    },
    pause: () => {
      if (paused) return;
      pausedAt = performance.now();
      paused = true;
    },
    resume: () => {
      if (!paused) return;
      const current = performance.now();
      accumulatedPause += current - pausedAt;
      lastDeltaTime += current - pausedAt;
      pausedAt = 0;
      paused = false;
    },
    get isPaused() { return paused; },
  });
}
