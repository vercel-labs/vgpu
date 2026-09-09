import type { DowngradeReason, QualityPreference, QualityReason, QualityState, QualityTier } from './quality';

/** Whatever one tier owns: targets, effects, pipelines. Built off-screen, swapped in when ready. */
export interface TierResources {
  /** Allocate and pre-compile everything. Runs while the previous tier keeps rendering. */
  prepare(): Promise<void>;
  destroy(): void;
}

export interface QualityControllerOptions<T extends TierResources> {
  /** Defaults to `auto`, which begins High. */
  readonly initialPreference?: QualityPreference;
  createTier(tier: QualityTier): T | Promise<T>;
  /** Runs with the prepared tier right before it replaces the previous one (resize, rebind). */
  onActivate?(tier: QualityTier, resources: T): void;
}

export interface QualityController<T extends TierResources> {
  /** Resolves when the first tier is on screen. Rejects if it cannot be built. */
  readonly ready: Promise<void>;
  readonly active: T | undefined;
  readonly state: QualityState;
  subscribe(listener: (state: QualityState) => void): () => void;
  setPreference(preference: QualityPreference): Promise<void>;
  /** Signals call this. Ignored unless the preference is `auto` and High is the requested tier. */
  downgrade(reason: DowngradeReason): Promise<void>;
  destroy(): void;
}

/**
 * Reconciles the requested tier with the tier on screen. A candidate is created and prepared
 * off-screen; if the request changed meanwhile it is discarded, otherwise it is swapped in and the
 * previous tier is destroyed. In `auto`, the only transition is High → Low, once.
 */
export function createQualityController<T extends TierResources>(
  options: QualityControllerOptions<T>,
): QualityController<T> {
  let preference: QualityPreference = options.initialPreference ?? 'auto';
  let requestedTier: QualityTier = preference === 'low' ? 'low' : 'high';
  let requestedReason: QualityReason = preference === 'auto' ? 'initial' : 'forced';
  let active: T | undefined;
  let activeTier: QualityTier | undefined;
  let activeReason: QualityReason = requestedReason;
  let running: Promise<void> | undefined;
  let disposed = false;
  const listeners = new Set<(state: QualityState) => void>();

  const state = (): QualityState => ({
    preference,
    effective: activeTier ?? requestedTier,
    reason: activeTier === undefined ? requestedReason : activeReason,
  });
  const emit = () => {
    const snapshot = state();
    for (const listener of listeners) listener(snapshot);
  };

  const run = async () => {
    while (!disposed && activeTier !== requestedTier) {
      const tier = requestedTier;
      const reason = requestedReason;
      let candidate: T;
      try {
        candidate = await options.createTier(tier);
      } catch (error) {
        if (disposed) return;
        if (tier !== requestedTier) continue;
        revert();
        throw error;
      }
      if (disposed || tier !== requestedTier) {
        candidate.destroy();
        continue;
      }
      try {
        await candidate.prepare();
      } catch (error) {
        candidate.destroy();
        if (disposed) return;
        if (tier !== requestedTier) continue;
        revert();
        throw error;
      }
      if (disposed || tier !== requestedTier) {
        candidate.destroy();
        continue;
      }
      options.onActivate?.(tier, candidate);
      const previous = active;
      active = candidate;
      activeTier = tier;
      activeReason = reason;
      previous?.destroy();
      emit();
    }
  };

  const revert = () => {
    if (activeTier === undefined) return;
    requestedTier = activeTier;
    requestedReason = activeReason;
    emit();
  };

  const ensureRunning = (): Promise<void> => {
    if (running) return running;
    const task = run();
    running = task;
    void task.then(
      () => {
        if (running === task) running = undefined;
      },
      () => {
        if (running === task) running = undefined;
      },
    );
    return task;
  };

  const ready = ensureRunning();

  return {
    ready,
    get active() {
      return active;
    },
    get state() {
      return state();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setPreference(next) {
      if (disposed) return Promise.resolve();
      preference = next;
      requestedTier = next === 'auto' ? 'high' : next;
      requestedReason = next === 'auto' ? 'initial' : 'forced';
      if (activeTier === requestedTier) {
        activeReason = requestedReason;
        emit();
        return running ?? Promise.resolve();
      }
      emit();
      return ensureRunning();
    },
    downgrade(reason) {
      if (disposed || preference !== 'auto' || requestedTier !== 'high') return Promise.resolve();
      requestedTier = 'low';
      requestedReason = reason;
      return ensureRunning();
    },
    destroy() {
      if (disposed) return;
      disposed = true;
      active?.destroy();
      active = undefined;
      activeTier = undefined;
      listeners.clear();
    },
  };
}
