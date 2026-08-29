interface PumpOptions {
  run(): Promise<void>;
  onError(error: unknown): void;
  minIntervalMs?: number;
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => number;
  clearTimer?: (handle: number) => void;
}

/** Single-flight, latest-only scheduling for image and camera inference. */
export function createInferencePump(options: PumpOptions) {
  const interval = options.minIntervalMs ?? 500;
  const now = options.now ?? Date.now;
  const setTimer =
    options.setTimer ??
    ((callback, ms) => setTimeout(callback, ms) as unknown as number);
  const clearTimer = options.clearTimer ?? clearTimeout;
  let stopped = false;
  let paused = false;
  let continuous = false;
  let pending = false;
  let timer: number | undefined;
  let active: Promise<void> | undefined;
  let lastFinished: number | undefined;

  const clearPendingTimer = () => {
    if (timer === undefined) return;
    clearTimer(timer);
    timer = undefined;
  };
  const schedule = () => {
    if (
      stopped ||
      paused ||
      active ||
      timer !== undefined ||
      (!pending && !continuous)
    )
      return;
    const elapsed =
      lastFinished === undefined ? Infinity : now() - lastFinished;
    const wait = Math.max(0, interval - elapsed);
    if (wait) {
      timer = setTimer(() => {
        timer = undefined;
        schedule();
      }, wait);
      return;
    }
    pending = false;
    active = options
      .run()
      .catch((error) => {
        if (!stopped) options.onError(error);
        stopped = true;
      })
      .finally(() => {
        active = undefined;
        lastFinished = now();
        schedule();
      });
  };

  return {
    request() {
      if (stopped) return;
      pending = true;
      schedule();
    },
    startContinuous() {
      if (stopped) return;
      continuous = true;
      schedule();
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
      schedule();
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

type Transition<T> = {
  value: T;
  run: (value: T, signal: AbortSignal) => Promise<void>;
};

/** Serializes model replacement and retains only the latest pending choice. */
export function createSwitchQueue<T>(onError: (error: unknown) => void) {
  let active: Promise<void> | undefined;
  let controller: AbortController | undefined;
  let pending: Transition<T> | undefined;
  let failure: { error: unknown } | undefined;

  const drain = () => {
    if (active || !pending) return;
    const next = pending;
    pending = undefined;
    failure = undefined;
    controller = new AbortController();
    active = next
      .run(next.value, controller.signal)
      .catch((error) => {
        failure = { error };
        onError(error);
      })
      .finally(() => {
        active = undefined;
        controller = undefined;
        drain();
      });
  };

  return {
    push(value: T, run: Transition<T>["run"]) {
      controller?.abort();
      pending = { value, run };
      drain();
    },
    cancel() {
      pending = undefined;
      controller?.abort();
    },
    get busy() {
      return active !== undefined;
    },
    get active() {
      return active;
    },
    get failure() {
      return failure;
    },
  };
}
