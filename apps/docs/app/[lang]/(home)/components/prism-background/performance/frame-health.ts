const DEFAULT_REFRESH_FPS = 60;
const MAX_INTERACTIVE_FPS = 90;
const AMBIENT_FPS = 30;
const HEALTH_WINDOW_MS = 2_000;
const HEALTH_RATIO = 0.8;
const REFRESH_SAMPLE_COUNT = 20;
const MAX_REFRESH_SAMPLES = 60;
const INACTIVE_GAP_MS = 250;

export type PrismFrameWorkload = "interactive" | "dust";

export interface PrismFrameHealthSample {
  /** Raw requestAnimationFrame interval, including frames skipped by our cap. */
  readonly deltaMs: number;
  /** Whether production animation had work during this requestAnimationFrame. */
  readonly active: boolean;
  /** Whether this requestAnimationFrame successfully presented production work. */
  readonly rendered: boolean;
  readonly mobile: boolean;
  readonly workload: PrismFrameWorkload;
}

export interface PrismFrameHealthStatus {
  readonly downgrade: boolean;
  readonly estimatedRefreshFps: number;
  readonly targetFps: number;
  readonly thresholdFps: number;
  readonly observedFps?: number;
  readonly activeWindowMs: number;
}

export interface PrismFrameHealthMonitor {
  record(sample: PrismFrameHealthSample): PrismFrameHealthStatus;
  reset(): void;
}

interface TimedFrame {
  readonly durationMs: number;
  readonly rendered: boolean;
}

/**
 * Pure live-health policy. It measures presented production frames over active
 * rAF time, so intentional 30/60/90 FPS caps are evaluated against their own
 * workload target instead of the browser's callback rate.
 */
export function createPrismFrameHealthMonitor(): PrismFrameHealthMonitor {
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
    resetActiveWindow();
  };

  const record = (sample: PrismFrameHealthSample): PrismFrameHealthStatus => {
    if (downgrade)
      return status(
        true,
        refreshFps,
        activeTargetFps ?? 60,
        activeRenderedFrames,
        activeDurationMs
      );
    if (
      !sample.active ||
      !Number.isFinite(sample.deltaMs) ||
      sample.deltaMs <= 0 ||
      sample.deltaMs > INACTIVE_GAP_MS
    ) {
      resetActiveWindow();
      return status(false, refreshFps, targetFps(sample, refreshFps), 0, 0);
    }

    const previousRefresh = refreshFps;
    refreshFps = updatedRefreshFps(refreshFps, refreshSamples, sample.deltaMs);
    refreshSamples.push(sample.deltaMs);
    if (refreshSamples.length > MAX_REFRESH_SAMPLES) refreshSamples.shift();

    const target = targetFps(sample, refreshFps);
    if (
      activeTargetFps !== undefined &&
      (Math.abs(activeTargetFps - target) > 0.5 ||
        Math.abs(previousRefresh - refreshFps) > 0.5)
    ) {
      resetActiveWindow();
    }
    activeTargetFps = target;

    const frame = { durationMs: sample.deltaMs, rendered: sample.rendered };
    activeFrames.push(frame);
    activeDurationMs += frame.durationMs;
    if (frame.rendered) activeRenderedFrames += 1;

    while (
      activeFrames.length > 1 &&
      activeDurationMs - activeFrames[0]!.durationMs >= HEALTH_WINDOW_MS
    ) {
      const removed = activeFrames.shift()!;
      activeDurationMs -= removed.durationMs;
      if (removed.rendered) activeRenderedFrames -= 1;
    }

    const observedFps =
      activeRenderedFrames / (activeDurationMs / 1_000);
    if (activeDurationMs >= HEALTH_WINDOW_MS) {
      if (observedFps < target * HEALTH_RATIO) downgrade = true;
    }

    return status(
      downgrade,
      refreshFps,
      target,
      activeRenderedFrames,
      activeDurationMs
    );
  };

  return { record, reset };
}

function targetFps(
  sample: Pick<PrismFrameHealthSample, "mobile" | "workload">,
  refreshFps: number
): number {
  if (sample.mobile || sample.workload === "dust") return AMBIENT_FPS;
  return Math.min(refreshFps, MAX_INTERACTIVE_FPS);
}

function updatedRefreshFps(
  current: number,
  samples: readonly number[],
  deltaMs: number
): number {
  if (deltaMs < 4 || deltaMs > 50) return current;
  const next = [...samples, deltaMs].slice(-REFRESH_SAMPLE_COUNT);
  if (next.length < REFRESH_SAMPLE_COUNT) return current;
  const sorted = [...next].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  const lower = sorted[Math.floor(sorted.length * 0.2)]!;
  const upper = sorted[Math.floor(sorted.length * 0.8)]!;
  // A faster refresh rate is accepted only after a stable sample window. The
  // seed is never lowered, so a 60 Hz display cannot accidentally target 90.
  if ((upper - lower) / median > 0.12) return current;
  const candidate = 1_000 / median;
  return candidate > current + 4 ? candidate : current;
}

function status(
  downgrade: boolean,
  estimatedRefreshFps: number,
  targetFps: number,
  renderedFrames: number,
  activeWindowMs: number
): PrismFrameHealthStatus {
  return {
    downgrade,
    estimatedRefreshFps,
    targetFps,
    thresholdFps: targetFps * HEALTH_RATIO,
    observedFps:
      activeWindowMs > 0
        ? renderedFrames / (activeWindowMs / 1_000)
        : undefined,
    activeWindowMs,
  };
}
