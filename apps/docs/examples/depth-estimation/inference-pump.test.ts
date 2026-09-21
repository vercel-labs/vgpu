import { describe, expect, it } from "vitest";
import { createInferencePump } from "./scheduling";

/**
 * Deterministic clock and timer queue. The pump takes both as options precisely
 * so its ordering rules can be tested without real time.
 */
function harness(options: { minIntervalMs?: number } = {}) {
  let now = 0;
  let nextHandle = 1;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const errors: unknown[] = [];

  let started = 0;
  let finished = 0;
  let release: (() => void) | undefined;

  const pump = createInferencePump({
    minIntervalMs: options.minIntervalMs ?? 0,
    now: () => now,
    setTimer: (callback, ms) => {
      const handle = nextHandle++;
      timers.set(handle, { at: now + ms, callback });
      return handle;
    },
    clearTimer: (handle) => void timers.delete(handle),
    onError: (error) => errors.push(error),
    run: () => {
      started += 1;
      return new Promise<void>((resolve) => {
        release = () => {
          finished += 1;
          release = undefined;
          resolve();
        };
      });
    },
  });

  return {
    pump,
    errors,
    get started() {
      return started;
    },
    get finished() {
      return finished;
    },
    /** Completes the in-flight run and lets the resulting microtasks settle. */
    async finish() {
      release?.();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    },
    /** Advances the clock and fires anything now due. */
    async advance(ms: number) {
      now += ms;
      for (const [handle, timer] of [...timers]) {
        if (timer.at <= now) {
          timers.delete(handle);
          timer.callback();
        }
      }
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

describe("createInferencePump", () => {
  it("runs a single request", async () => {
    const h = harness();
    h.pump.request();
    expect(h.started).toBe(1);
    await h.finish();
    expect(h.finished).toBe(1);
    expect(h.started).toBe(1);
  });

  it("never overlaps runs", async () => {
    const h = harness();
    h.pump.request();
    h.pump.request();
    h.pump.request();
    // Three requests, one in-flight run: the model is asked for work once.
    expect(h.started).toBe(1);
  });

  it("coalesces requests made during a run into exactly one follow-up", async () => {
    const h = harness();
    h.pump.request();
    h.pump.request();
    h.pump.request();
    await h.finish();
    expect(h.started).toBe(2);
    await h.finish();
    // Nothing was left pending, so it stops rather than looping.
    expect(h.started).toBe(2);
  });

  it("waits out the minimum interval before the next run", async () => {
    const h = harness({ minIntervalMs: 500 });
    h.pump.request();
    expect(h.started).toBe(1);
    h.pump.request();
    await h.finish();
    // The follow-up is due 500 ms after the first run finished.
    expect(h.started).toBe(1);
    await h.advance(499);
    expect(h.started).toBe(1);
    await h.advance(1);
    expect(h.started).toBe(2);
  });

  it("keeps running in continuous mode without further requests", async () => {
    const h = harness();
    h.pump.startContinuous();
    expect(h.started).toBe(1);
    await h.finish();
    expect(h.started).toBe(2);
    await h.finish();
    expect(h.started).toBe(3);
    h.pump.stopContinuous();
    await h.finish();
    expect(h.started).toBe(3);
  });

  it("pauses while a session is replaced and resumes inference on the new session", async () => {
    const h = harness();
    h.pump.request();
    const active = h.pump.pause();
    await h.finish();
    await active;

    h.pump.request();
    expect(h.started).toBe(1);
    h.pump.resume();
    h.pump.request();
    expect(h.started).toBe(2);
  });

  it("stops scheduling after stop() and hands back the in-flight run", async () => {
    const h = harness();
    h.pump.startContinuous();
    const active = h.pump.stop();
    expect(active).toBeInstanceOf(Promise);
    await h.finish();
    await active;
    h.pump.request();
    expect(h.started).toBe(1);
  });

  it("reports the first failure once and then stays down", async () => {
    const errors: unknown[] = [];
    let started = 0;
    const pump = createInferencePump({
      minIntervalMs: 0,
      now: () => 0,
      setTimer: (callback) => {
        callback();
        return 1;
      },
      clearTimer: () => {},
      onError: (error) => errors.push(error),
      run: () => {
        started += 1;
        return Promise.reject(new Error("inference exploded"));
      },
    });

    pump.startContinuous();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("inference exploded");
    // A pump that retried a broken run every interval would bury the error and
    // pin the GPU, so one failure is terminal.
    expect(started).toBe(1);
    pump.request();
    expect(started).toBe(1);
  });
});
