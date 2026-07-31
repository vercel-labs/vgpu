/**
 * Single-flight, latest-frame-wins inference scheduler.
 *
 * The display loop runs continuously at rAF and must never wait for a pose
 * result, so the two loops are decoupled here. The rules:
 *
 * - Exactly one `run` is in flight at any time. Never two `session.run` calls.
 * - While one is running, newer frames coalesce into a single pending token; the
 *   intermediate ones are dropped on purpose, because a stale pose is worthless.
 * - The same frame token is never inferred twice, so a rAF tick without a fresh
 *   decoded frame does not cause redundant work.
 * - The first failure is reported once, and the scheduler stops.
 *
 * This module follows the same single-flight pump idea used elsewhere in the ML
 * examples, but the semantics differ enough to be its own file: this one is
 * producer-driven and coalescing, not a self-scheduling animation loop.
 * It is deliberately free of GPU, DOM and ORT types so ordering can be unit
 * tested with fakes.
 */
export interface InferenceSchedulerOptions<Token> {
  /** Runs one complete inference; the scheduler waits for the returned promise. */
  run(token: Token): Promise<void>;
  onError(error: unknown): void;
}

export interface InferenceScheduler<Token> {
  /**
   * Announces a fresh frame. Coalesces: only the newest token survives until the
   * in-flight run finishes.
   */
  request(token: Token): void;
  /** The in-flight run, if any. */
  readonly active: Promise<void> | undefined;
  /** True while a newer token is waiting for the in-flight run to finish. */
  readonly pending: boolean;
  readonly stopped: boolean;
  /** Number of completed runs; useful for status lines and tests. */
  readonly completed: number;
  /**
   * Refuses further runs and returns the in-flight one so teardown can drain it
   * before releasing the session and the borrowed buffers.
   */
  stop(): Promise<void> | undefined;
}

export function createInferenceScheduler<Token>(
  options: InferenceSchedulerOptions<Token>,
): InferenceScheduler<Token> {
  let stopped = false;
  let active: Promise<void> | undefined;
  let pending: { token: Token } | undefined;
  let completed = 0;

  const pump = () => {
    if (stopped || active || !pending) return;
    const { token } = pending;
    pending = undefined;
    active = options
      .run(token)
      .then(() => {
        completed++;
      })
      .catch((error: unknown) => {
        // One report, then stop: a broken session produces the same error every
        // frame and would flood the host.
        if (!stopped) options.onError(error);
        stopped = true;
        pending = undefined;
      })
      .finally(() => {
        active = undefined;
        pump();
      });
  };

  return {
    request(token) {
      if (stopped) return;
      pending = { token };
      pump();
    },
    get active() {
      return active;
    },
    get pending() {
      return pending !== undefined;
    },
    get stopped() {
      return stopped;
    },
    get completed() {
      return completed;
    },
    stop() {
      stopped = true;
      pending = undefined;
      return active;
    },
  };
}
