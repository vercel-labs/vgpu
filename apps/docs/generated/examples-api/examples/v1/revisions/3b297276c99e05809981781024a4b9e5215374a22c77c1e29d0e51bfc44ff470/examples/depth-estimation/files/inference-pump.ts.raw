/**
 * Latest-only, single-flight inference scheduler.
 *
 * Depth inference is slow enough that naive scheduling destroys the example: a
 * webcam at 30 fps in front of a 60 ms model would queue work forever and the
 * picture would drift further behind reality every second. So this pump runs at
 * most ONE inference at a time and remembers only that another is wanted, never
 * how many. A frame that arrives while a run is in flight replaces the pending
 * request instead of joining a backlog.
 *
 * After each run completes it waits out `minIntervalMs` before starting the
 * next, which leaves the GPU time to actually present frames.
 *
 * Deliberately free of GPU, DOM and ORT types so the ordering rules can be
 * tested with fake timers.
 */
export interface InferencePumpOptions {
  /** Runs one complete inference; the pump waits for the returned promise. */
  run(): Promise<void>;
  onError(error: unknown): void;
  /** Floor on the gap between the end of one run and the start of the next. */
  minIntervalMs?: number;
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => number;
  clearTimer?: (handle: number) => void;
}

export interface InferencePump {
  /** Asks for one more run. Coalesces: two requests during a run cause one run. */
  request(): void;
  /** Keeps requesting until `stop()`; used by webcam mode. */
  startContinuous(): void;
  stopContinuous(): void;
  /** Temporarily prevents runs and drops pending work while a session is replaced. */
  pause(): Promise<void> | undefined;
  /** Allows requests again after a session replacement. */
  resume(): void;
  /** Permanently prevents further runs. Returns the in-flight run for draining. */
  stop(): Promise<void> | undefined;
  readonly active: Promise<void> | undefined;
  readonly continuous: boolean;
}

export function createInferencePump(options: InferencePumpOptions): InferencePump {
  const minIntervalMs = options.minIntervalMs ?? 500;
  const now = options.now ?? (() => Date.now());
  const setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms) as unknown as number);
  const clearTimer = options.clearTimer ?? ((handle: number) => clearTimeout(handle));

  let stopped = false;
  let paused = false;
  let continuous = false;
  let pending = false;
  let timer: number | undefined;
  let active: Promise<void> | undefined;
  let lastFinishedAt: number | undefined;

  const clearPendingTimer = () => {
    if (timer !== undefined) {
      clearTimer(timer);
      timer = undefined;
    }
  };

  const maybeRun = () => {
    if (stopped || paused || active || timer !== undefined) return;
    if (!pending && !continuous) return;

    const elapsed = lastFinishedAt === undefined ? Number.POSITIVE_INFINITY : now() - lastFinishedAt;
    const wait = Math.max(0, minIntervalMs - elapsed);
    if (wait > 0) {
      timer = setTimer(() => {
        timer = undefined;
        maybeRun();
      }, wait);
      return;
    }

    pending = false;
    active = options
      .run()
      .catch((error: unknown) => {
        // One failure stops the pump: repeating a broken run every 500 ms would
        // bury the real error and pin the GPU.
        if (!stopped) options.onError(error);
        stopped = true;
      })
      .finally(() => {
        active = undefined;
        lastFinishedAt = now();
        maybeRun();
      });
  };

  return {
    request() {
      if (stopped) return;
      pending = true;
      maybeRun();
    },
    startContinuous() {
      if (stopped) return;
      continuous = true;
      maybeRun();
    },
    stopContinuous() {
      continuous = false;
      if (!pending) clearPendingTimer();
    },
    pause() {
      paused = true;
      continuous = false;
      pending = false;
      clearPendingTimer();
      return active;
    },
    resume() {
      if (stopped) return;
      paused = false;
      maybeRun();
    },
    stop() {
      stopped = true;
      paused = true;
      continuous = false;
      pending = false;
      clearPendingTimer();
      return active;
    },
    get active() {
      return active;
    },
    get continuous() {
      return continuous;
    },
  };
}
