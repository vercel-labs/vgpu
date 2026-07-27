/**
 * Single-flight animation pump.
 *
 * Inference must never overlap: the next frame is only scheduled after the
 * previous run, submit, and queue flush have completed. `gpu.frame.loop` cannot
 * express that, so the pump owns the scheduling instead.
 *
 * This module is deliberately free of GPU and ORT types so the ordering rules
 * can be unit tested with fake timers.
 */
export interface FramePumpHost {
  /** Usually `requestAnimationFrame`; returns a cancellable handle. */
  requestFrame(callback: (timestampMs: number) => void): number;
  cancelFrame(handle: number): void;
}

export interface FramePumpOptions extends FramePumpHost {
  /** Runs one complete frame; the pump waits for the returned promise. */
  run(timestampMs: number): Promise<void>;
  onError(error: unknown): void;
}

export interface FramePump {
  start(): void;
  /** Prevents further frames. Returns the in-flight frame, if any. */
  stop(): Promise<void> | undefined;
  readonly active: Promise<void> | undefined;
}

export function createFramePump(options: FramePumpOptions): FramePump {
  let stopped = false;
  let handle = 0;
  let active: Promise<void> | undefined;

  const schedule = () => {
    if (stopped || handle || active) return;
    handle = options.requestFrame((timestampMs) => {
      handle = 0;
      if (stopped) return;
      active = options
        .run(timestampMs)
        .catch((error: unknown) => {
          if (!stopped) options.onError(error);
          stopped = true;
        })
        .finally(() => {
          active = undefined;
          schedule();
        });
    });
  };

  return {
    start() {
      if (stopped) return;
      schedule();
    },
    stop() {
      stopped = true;
      if (handle) options.cancelFrame(handle);
      handle = 0;
      return active;
    },
    get active() {
      return active;
    },
  };
}

/** Rolling frames-per-second estimate over a fixed reporting window. */
export function createFpsMeter(windowMs = 500) {
  let frames = 0;
  let windowStart: number | undefined;
  return {
    /** Returns a new fps value once per window, otherwise `undefined`. */
    sample(timestampMs: number): number | undefined {
      windowStart ??= timestampMs;
      frames++;
      const elapsed = timestampMs - windowStart;
      if (elapsed < windowMs) return undefined;
      const fps = (frames * 1000) / elapsed;
      frames = 0;
      windowStart = timestampMs;
      return fps;
    },
  };
}
