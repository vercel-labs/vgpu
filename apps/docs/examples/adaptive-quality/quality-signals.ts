import type { TierResult } from '@pmndrs/detect-gpu';

import { createFrameHealthMonitor, type FrameHealthMonitor, type FrameHealthSample } from './frame-health';
import type { DowngradeReason } from './quality';

const DEFAULT_LOW_BATTERY_LEVEL = 0.3;

interface BatteryManagerLike extends EventTarget {
  readonly charging: boolean;
  readonly level: number;
}

interface NavigatorWithBattery {
  getBattery?(): Promise<BatteryManagerLike>;
}

export interface QualityLogger {
  info(message: string, details?: unknown): void;
}

export interface QualitySignals {
  /** Feed one sample per requestAnimationFrame tick while High is on screen. */
  recordFrame(sample: FrameHealthSample): void;
  /** Forget health history, for example right after a resize or a pipeline swap. */
  resetHealth(): void;
  dispose(): void;
}

export interface QualitySignalsOptions {
  /** Fires at most once. Every signal is advisory: failures keep High. */
  onDowngrade(reason: DowngradeReason): void;
  /**
   * Same-origin copy of detect-gpu's benchmark tables (`dist/benchmarks` from the package).
   * Omit to use detect-gpu's default CDN; a blocked fetch keeps High.
   */
  readonly benchmarksUrl?: string;
  /** Inclusive battery level that requests Low while discharging. Defaults to 0.3. */
  readonly lowBatteryLevel?: number;
  /** Test seam; production uses the browser navigator. */
  readonly navigator?: NavigatorWithBattery;
  /** Test seam; production imports detect-gpu lazily. */
  loadGpuTier?(): Promise<TierResult>;
  /** Test seam for deterministic health policy tests. */
  readonly healthMonitor?: FrameHealthMonitor;
  /** Structured diagnostics. Defaults to the console. */
  readonly logger?: QualityLogger;
}

/**
 * Starts the three advisory signals (GPU tier, battery, frame health) and reports the first one
 * that asks for Low. Import this module *after* the first High frame has been presented so
 * neither its code nor detect-gpu's benchmark request can delay first paint.
 */
export function createQualitySignals(options: QualitySignalsOptions): QualitySignals {
  let disposed = false;
  let downgraded = false;
  let battery: BatteryManagerLike | undefined;
  const health = options.healthMonitor ?? createFrameHealthMonitor();
  const logger = options.logger ?? console;
  const lowBatteryLevel = options.lowBatteryLevel ?? DEFAULT_LOW_BATTERY_LEVEL;
  const browserNavigator =
    options.navigator ?? (typeof navigator === 'undefined' ? undefined : (navigator as NavigatorWithBattery));

  const requestLow = (reason: DowngradeReason) => {
    if (disposed || downgraded) return;
    downgraded = true;
    options.onDowngrade(reason);
  };

  const loadGpuTier =
    options.loadGpuTier ??
    (async () => {
      const { getGPUTier } = await import('@pmndrs/detect-gpu');
      return getGPUTier(options.benchmarksUrl ? { benchmarksURL: options.benchmarksUrl } : {});
    });
  void Promise.resolve()
    .then(loadGpuTier)
    .then((result) => {
      if (disposed) return;
      const requestsLow = gpuTierRequestsLow(result);
      logger.info('[quality] GPU detected.', {
        type: result.type,
        tier: result.tier,
        gpu: result.gpu,
        fps: result.fps,
        isMobile: result.isMobile,
        decision: requestsLow ? 'request-low' : 'keep-high',
      });
      if (requestsLow) requestLow('gpu-tier');
    })
    .catch((error: unknown) => {
      if (!disposed) {
        logger.info('[quality] GPU detection unavailable.', { error: errorMessage(error), decision: 'keep-high' });
      }
    });

  const onBatteryChange = (event?: Event) => {
    if (!battery || disposed) return;
    const requestsLow = batteryRequestsLow(battery, lowBatteryLevel);
    logger.info('[quality] Battery status.', {
      source: event?.type ?? 'initial',
      level: battery.level,
      charging: battery.charging,
      decision: requestsLow ? 'request-low' : 'keep-high',
    });
    if (requestsLow) requestLow('battery');
  };
  let batteryPromise: Promise<BatteryManagerLike> | undefined;
  if (!browserNavigator?.getBattery) {
    logger.info('[quality] Battery status unavailable.', { reason: 'unsupported' });
  } else {
    try {
      batteryPromise = browserNavigator.getBattery();
    } catch (error) {
      logger.info('[quality] Battery status unavailable.', { reason: 'rejected', error: errorMessage(error) });
    }
  }
  if (batteryPromise) {
    void batteryPromise
      .then((manager) => {
        if (disposed) return;
        battery = manager;
        onBatteryChange();
        if (downgraded) return;
        manager.addEventListener('levelchange', onBatteryChange);
        manager.addEventListener('chargingchange', onBatteryChange);
      })
      .catch((error: unknown) => {
        if (!disposed) {
          logger.info('[quality] Battery status unavailable.', { reason: 'rejected', error: errorMessage(error) });
        }
      });
  }

  return {
    recordFrame(sample) {
      if (disposed || downgraded) return;
      const status = health.record(sample);
      if (!status.downgrade) return;
      logger.info('[quality] Frame health below target.', {
        estimatedRefreshFps: round(status.estimatedRefreshFps),
        targetFps: round(status.targetFps),
        thresholdFps: round(status.thresholdFps),
        observedFps: status.observedFps === undefined ? undefined : round(status.observedFps),
        activeWindowMs: Math.round(status.activeWindowMs),
        decision: 'request-low',
      });
      requestLow('frame-health');
    },
    resetHealth() {
      if (!disposed && !downgraded) health.reset();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      battery?.removeEventListener('levelchange', onBatteryChange);
      battery?.removeEventListener('chargingchange', onBatteryChange);
      battery = undefined;
    },
  };
}

/** Mobile devices, blocklisted GPUs, and benchmark-backed tiers 0–1 use Low. Unknown GPUs keep High. */
export function gpuTierRequestsLow(result: Pick<TierResult, 'tier' | 'type' | 'isMobile'>): boolean {
  return (
    result.isMobile === true ||
    result.type === 'BLOCKLISTED' ||
    (result.type === 'BENCHMARK' && result.tier <= 1)
  );
}

/** Inclusive threshold, ignored while the device is plugged in. */
export function batteryRequestsLow(
  battery: Pick<BatteryManagerLike, 'charging' | 'level'> | undefined,
  lowLevel = DEFAULT_LOW_BATTERY_LEVEL,
): boolean {
  return battery?.charging === false && Number.isFinite(battery.level) && battery.level <= lowLevel;
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
