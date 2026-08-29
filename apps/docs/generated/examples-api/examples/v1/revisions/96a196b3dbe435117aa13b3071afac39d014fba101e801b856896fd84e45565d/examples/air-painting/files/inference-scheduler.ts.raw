// Runs one inference at a time and coalesces queued frames to the newest token.
export interface InferenceSchedulerOptions<Token> {
  run(token: Token): Promise<void>;
  onError(error: unknown): void;
}

export interface InferenceScheduler<Token> {
  request(token: Token): void;
  readonly active: Promise<void> | undefined;
  readonly pending: boolean;
  readonly stopped: boolean;
  stop(): Promise<void> | undefined;
}

export function createInferenceScheduler<Token>(
  options: InferenceSchedulerOptions<Token>
): InferenceScheduler<Token> {
  let stopped = false;
  let active: Promise<void> | undefined;
  let pending: { token: Token } | undefined;

  const pump = () => {
    if (stopped || active || !pending) return;
    const { token } = pending;
    pending = undefined;
    active = options
      .run(token)
      .catch((error: unknown) => {
        // Report once, then stop before a broken session can flood the host.
        const report = !stopped;
        stopped = true;
        pending = undefined;
        if (report) options.onError(error);
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
    stop() {
      stopped = true;
      pending = undefined;
      return active;
    },
  };
}
