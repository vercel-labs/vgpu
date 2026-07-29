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
 * Transitions therefore run one at a time. Pushing a newer choice aborts the
 * active transition's cancellable work (notably fetch) and replaces any choice
 * still waiting to start. The active transition still owns the serialization
 * lock until it settles, so an unabortable ORT session creation never overlaps
 * a later one.
 *
 * The module is deliberately free of GPU, DOM and ORT types so the ordering and
 * cancellation rules are unit-testable.
 */
export interface SwitchQueue<T> {
  /** Queues `value`, superseding and cancelling every older choice. */
  push(value: T, run: (value: T, signal: AbortSignal) => Promise<void>): void;
  /** Aborts active cancellable work and drops a waiting transition. */
  cancel(): void;
  /** True while a transition is in flight. */
  readonly busy: boolean;
  /** The transition in flight, so callers can drain before disposing. */
  readonly active: Promise<void> | undefined;
}

export function createSwitchQueue<T>(onError: (error: unknown) => void): SwitchQueue<T> {
  let active: Promise<void> | undefined;
  let activeController: AbortController | undefined;
  let pending:
    | { value: T; run: (value: T, signal: AbortSignal) => Promise<void> }
    | undefined;

  const drain = (): void => {
    if (active || !pending) return;
    const next = pending;
    pending = undefined;
    const controller = new AbortController();
    activeController = controller;
    active = next
      .run(next.value, controller.signal)
      .catch(onError)
      .finally(() => {
        active = undefined;
        activeController = undefined;
        // A choice made while this ran starts now.
        drain();
      });
  };

  return {
    push(value, run) {
      // Abort an obsolete fetch immediately. Its promise still has to settle
      // before drain starts the replacement, preserving strict serialization.
      activeController?.abort();
      // Replaces rather than appends: intermediate choices are never loaded.
      pending = { value, run };
      drain();
    },
    cancel() {
      pending = undefined;
      activeController?.abort();
    },
    get busy() {
      return active !== undefined;
    },
    get active() {
      return active;
    },
  };
}
