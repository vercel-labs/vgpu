/**
 * Serializes the teardown/rebuild sequence behind the model picker.
 *
 * Switching models is not a quick state change: the old ONNX Runtime session
 * has to drain and release before the next one is built, and the next one may
 * be a 94 MiB download. Two things go wrong without sequencing. Overlapping
 * switches would run a teardown against a session another switch is still
 * initializing, and a user clicking through the list would leave every
 * intermediate model to load in full before reaching the one actually wanted.
 *
 * So transitions run one at a time, and a transition that has been superseded
 * while it waited is dropped rather than run: only the newest choice survives.
 * The module is deliberately free of GPU, DOM and ORT types so the ordering is
 * unit-testable.
 */
export interface SwitchQueue<T> {
  /** Queues `value`, superseding any choice still waiting to start. */
  push(value: T, run: (value: T) => Promise<void>): void;
  /** True while a transition is in flight. */
  readonly busy: boolean;
  /** The transition in flight, so callers can drain before disposing. */
  readonly active: Promise<void> | undefined;
}

export function createSwitchQueue<T>(onError: (error: unknown) => void): SwitchQueue<T> {
  let active: Promise<void> | undefined;
  let pending: { value: T; run: (value: T) => Promise<void> } | undefined;

  const drain = (): void => {
    if (active || !pending) return;
    const next = pending;
    pending = undefined;
    active = next
      .run(next.value)
      .catch(onError)
      .finally(() => {
        active = undefined;
        // A choice made while this ran starts now.
        drain();
      });
  };

  return {
    push(value, run) {
      // Replaces rather than appends: intermediate choices are never loaded.
      pending = { value, run };
      drain();
    },
    get busy() {
      return active !== undefined;
    },
    get active() {
      return active;
    },
  };
}
