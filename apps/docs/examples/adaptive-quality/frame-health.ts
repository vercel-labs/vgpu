const DEFAULT_REFRESH_FPS = 60;
const MAX_INTERACTIVE_FPS = 90;
const HEALTH_WINDOW_MS = 2_000;
const HEALTH_RATIO = 0.8;
const REFRESH_SAMPLE_COUNT = 20;
const MAX_REFRESH_SAMPLES = 60;
const INACTIVE_GAP_MS = 250;

export interface FrameHealthSample {
  /** Raw requestAnimationFrame interval in milliseconds, including frames you skipped on purpose. */
  readonly deltaMs: number;
  /** The renderer had work to do this tick, the page was visible, and the High tier was in Auto. */
  readonly active: boolean;
  /** This tick actually presented a frame. False when a frame cap or "nothing changed" skipped it. */
  readonly rendered: boolean;
  /**
   * Intentional frame cap for this tick (for example 30 for an ambient loop). Omit to target the
   * display refresh rate, capped at 90 FPS.
   */
  readonly targetFps?: number;
}

export interface FrameHealthStatus {
  readonly downgrade: boolean;
  readonly estimatedRefreshFps: number;
  readonly targetFps: number;
  readonly thresholdFps: number;
  readonly observedFps?: number;
  readonly activeWindowMs: number;
}

export interface FrameHealthMonitor {
  record(sample: FrameHealthSample): FrameHealthStatus;
  reset(): void;
}

export interface FrameHealthOptions {
  /** Active time that must accumulate before a verdict. Defaults to 2000 ms. */
  readonly windowMs?: number;
  /** Downgrade when presented FPS falls below `ratio × target`. Defaults to 0.8. */
  readonly ratio?: number;
  /** Upper bound for the auto-detected refresh target. Defaults to 90. */
  readonly maxFps?: number;
}

interface TimedFrame {
  readonly durationMs: number;
  readonly rendered: boolean;
}

/**
 * Pure live-health policy. It measures presented frames over *active* animation time, so an
 * intentional 30 FPS cap is judged against 30, a 60 Hz display against 60, and a 120 Hz display
 * against 90. Hidden tabs and idle gaps (> 250 ms) reset the window instead of counting as drops.
 * Once `downgrade` is true it stays true until `reset()`.
 */
export function createFrameHealthMonitor(options: FrameHealthOptions = {}): FrameHealthMonitor {
  const windowMs = options.windowMs ?? HEALTH_WINDOW_MS;
  const ratio = options.ratio ?? HEALTH_RATIO;
  const maxFps = options.maxFps ?? MAX_INTERACTIVE_FPS;
  let refreshFps = DEFAULT_REFRESH_FPS;
  let refreshSamples: number[] = [];
  let activeFrames: TimedFrame[] = [];
  let activeDurationMs = 0;
  let activeRenderedFrames = 0;
  let activeTargetFps: number | undefined;
  let downgrade = false;

  const resetActiveWindow = () => {
    activeFrames = [];
    activeDurationMs = 0;
    activeRenderedFrames = 0;
    activeTargetFps = undefined;
  };

  const reset = () => {
    refreshFps = DEFAULT_REFRESH_FPS;
    refreshSamples = [];
    downgrade = false;
    resetActiveWindow();
  };

  const targetFor = (sample: FrameHealthSample): number =>
    sample.targetFps !== undefined && Number.isFinite(sample.targetFps) && sample.targetFps > 0
      ? Math.min(sample.targetFps, refreshFps)
      : Math.min(refreshFps, maxFps);

  const record = (sample: FrameHealthSample): FrameHealthStatus => {
    if (downgrade) {
      return status(true, refreshFps, activeTargetFps ?? DEFAULT_REFRESH_FPS, activeRenderedFrames, activeDurationMs, ratio);
    }
    if (
      !sample.active ||
      !Number.isFinite(sample.deltaMs) ||
      sample.deltaMs <= 0 ||
      sample.deltaMs > INACTIVE_GAP_MS
    ) {
      resetActiveWindow();
      return status(false, refreshFps, targetFor(sample), 0, 0, ratio);
    }

    const previousRefresh = refreshFps;
    refreshFps = updatedRefreshFps(refreshFps, refreshSamples, sample.deltaMs);
    refreshSamples.push(sample.deltaMs);
    if (refreshSamples.length > MAX_REFRESH_SAMPLES) refreshSamples.shift();

    const target = targetFor(sample);
    if (
      activeTargetFps !== undefined &&
      (Math.abs(activeTargetFps - target) > 0.5 || Math.abs(previousRefresh - refreshFps) > 0.5)
    ) {
      resetActiveWindow();
    }
    activeTargetFps = target;

    const frame = { durationMs: sample.deltaMs, rendered: sample.rendered };
    activeFrames.push(frame);
    activeDurationMs += frame.durationMs;
    if (frame.rendered) activeRenderedFrames += 1;

    while (activeFrames.length > 1 && activeDurationMs - activeFrames[0]!.durationMs >= windowMs) {
      const removed = activeFrames.shift()!;
      activeDurationMs -= removed.durationMs;
      if (removed.rendered) activeRenderedFrames -= 1;
    }

    const observedFps = activeRenderedFrames / (activeDurationMs / 1_000);
    if (activeDurationMs >= windowMs && observedFps < target * ratio) downgrade = true;

    return status(downgrade, refreshFps, target, activeRenderedFrames, activeDurationMs, ratio);
  };

  return { record, reset };
}

function updatedRefreshFps(current: number, samples: readonly number[], deltaMs: number): number {
  if (deltaMs < 4 || deltaMs > 50) return current;
  const next = [...samples, deltaMs].slice(-REFRESH_SAMPLE_COUNT);
  if (next.length < REFRESH_SAMPLE_COUNT) return current;
  const sorted = [...next].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  const lower = sorted[Math.floor(sorted.length * 0.2)]!;
  const upper = sorted[Math.floor(sorted.length * 0.8)]!;
  // A faster refresh rate is accepted only after a stable sample window. The seed is never
  // lowered, so a 60 Hz display cannot accidentally be judged against 90.
  if ((upper - lower) / median > 0.12) return current;
  const candidate = 1_000 / median;
  return candidate > current + 4 ? candidate : current;
}

function status(
  downgrade: boolean,
  refreshFps: number,
  targetFps: number,
  renderedFrames: number,
  activeWindowMs: number,
  ratio: number,
): FrameHealthStatus {
  return {
    downgrade,
    estimatedRefreshFps: refreshFps,
    targetFps,
    thresholdFps: targetFps * ratio,
    observedFps: activeWindowMs > 0 ? renderedFrames / (activeWindowMs / 1_000) : undefined,
    activeWindowMs,
  };
}
