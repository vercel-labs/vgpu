import type { TierResult } from "@pmndrs/detect-gpu";

import type { PrismQualityReason } from "../pipelines/types";
import {
  createPrismFrameHealthMonitor,
  type PrismFrameHealthMonitor,
  type PrismFrameHealthSample,
} from "./frame-health";

const BENCHMARKS_URL = "/prism-gpu-benchmarks";
const LOW_BATTERY_LEVEL = 0.3;

interface BatteryManagerLike extends EventTarget {
  readonly charging: boolean;
  readonly level: number;
}

interface NavigatorWithBattery {
  getBattery?(): Promise<BatteryManagerLike>;
}

export interface PrismQualityLogger {
  info(message: string, details?: unknown): void;
}

export interface PrismAutoQualityController {
  recordFrame(sample: PrismFrameHealthSample): void;
  resetHealth(): void;
  dispose(): void;
}

export interface PrismAutoQualityControllerOptions {
  onDowngrade(reason: Extract<PrismQualityReason, "gpu-tier" | "battery" | "runtime">): void;
  /** Test seam; production uses the browser navigator. */
  readonly navigator?: NavigatorWithBattery;
  /** Test seam; production imports detect-gpu only after this module loads. */
  loadGpuTier?(): Promise<TierResult>;
  /** Test seam for deterministic health policy tests. */
  readonly healthMonitor?: PrismFrameHealthMonitor;
  /** Test seam; production writes structured quality diagnostics to the console. */
  readonly logger?: PrismQualityLogger;
}

/**
 * Starts all Auto signals. This module itself is imported only after the first
 * successful High frame; detect-gpu is a second dynamic import so neither its
 * code nor its vendor benchmark request can delay that frame.
 */
export function createPrismAutoQualityController(
  options: PrismAutoQualityControllerOptions
): PrismAutoQualityController {
  let disposed = false;
  let downgraded = false;
  let battery: BatteryManagerLike | undefined;
  const health = options.healthMonitor ?? createPrismFrameHealthMonitor();
  const logger = options.logger ?? console;
  const browserNavigator =
    options.navigator ??
    (typeof navigator === "undefined"
      ? undefined
      : (navigator as NavigatorWithBattery));

  const requestLow = (
    reason: Extract<PrismQualityReason, "gpu-tier" | "battery" | "runtime">
  ) => {
    if (disposed || downgraded) return;
    downgraded = true;
    options.onDowngrade(reason);
  };

  const loadGpuTier =
    options.loadGpuTier ??
    (async () => {
      const { getGPUTier } = await import("@pmndrs/detect-gpu");
      return getGPUTier({ benchmarksURL: BENCHMARKS_URL });
    });
  void Promise.resolve()
    .then(loadGpuTier)
    .then((result) => {
      if (disposed) return;
      const requestsLow = gpuTierRequestsLow(result);
      logger.info("[Prism quality] GPU detected.", {
        type: result.type,
        tier: result.tier,
        gpu: result.gpu,
        fps: result.fps,
        isMobile: result.isMobile,
        device: result.device,
        decision: requestsLow ? "request-low" : "keep-high",
      });
      if (requestsLow) requestLow("gpu-tier");
    })
    .catch((error: unknown) => {
      if (!disposed)
        logger.info("[Prism quality] GPU detection unavailable.", {
          error: errorMessage(error),
          decision: "keep-high",
        });
      // Imports, WebGL probing, and benchmark fetches are advisory in Auto.
    });

  const onBatteryChange = (event?: Event) => {
    if (!battery || disposed) return;
    const requestsLow = batteryRequestsLow(battery);
    logger.info("[Prism quality] Battery status.", {
      source: event?.type ?? "initial",
      level: battery.level,
      charging: battery.charging,
      decision: requestsLow ? "request-low" : "keep-high",
    });
    if (requestsLow) requestLow("battery");
  };
  let batteryPromise: Promise<BatteryManagerLike> | undefined;
  if (!browserNavigator?.getBattery) {
    logger.info("[Prism quality] Battery status unavailable.", {
      reason: "unsupported",
    });
  } else {
    try {
      batteryPromise = browserNavigator.getBattery();
    } catch (error) {
      logger.info("[Prism quality] Battery status unavailable.", {
        reason: "rejected",
        error: errorMessage(error),
      });
    }
  }
  if (batteryPromise) {
    void batteryPromise
      .then((manager) => {
        if (disposed) return;
        battery = manager;
        onBatteryChange();
        if (downgraded) return;
        manager.addEventListener("levelchange", onBatteryChange);
        manager.addEventListener("chargingchange", onBatteryChange);
      })
      .catch((error: unknown) => {
        if (!disposed)
          logger.info("[Prism quality] Battery status unavailable.", {
            reason: "rejected",
            error: errorMessage(error),
          });
        // The Battery Status API is optional and commonly unavailable.
      });
  }

  return {
    recordFrame(sample) {
      if (disposed || downgraded) return;
      const status = health.record(sample);
      if (!status.downgrade) return;
      logger.info("[Prism quality] Runtime health below target.", {
        workload: sample.workload,
        mobile: sample.mobile,
        estimatedRefreshFps: roundFps(status.estimatedRefreshFps),
        targetFps: roundFps(status.targetFps),
        thresholdFps: roundFps(status.thresholdFps),
        observedFps:
          status.observedFps === undefined
            ? undefined
            : roundFps(status.observedFps),
        activeWindowMs: Math.round(status.activeWindowMs),
        decision: "request-low",
      });
      requestLow("runtime");
    },
    resetHealth() {
      if (!disposed && !downgraded) health.reset();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      battery?.removeEventListener("levelchange", onBatteryChange);
      battery?.removeEventListener("chargingchange", onBatteryChange);
      battery = undefined;
    },
  };
}

/** Mobile devices, benchmark-backed low tiers, and the blocklist use Low. */
export function gpuTierRequestsLow(
  result: Pick<TierResult, "tier" | "type" | "isMobile">
): boolean {
  return (
    result.isMobile === true ||
    result.type === "BLOCKLISTED" ||
    (result.type === "BENCHMARK" && result.tier <= 1)
  );
}

/** Inclusive 30% threshold, ignored while the device is plugged in. */
export function batteryRequestsLow(
  battery: Pick<BatteryManagerLike, "charging" | "level"> | undefined
): boolean {
  return (
    battery?.charging === false &&
    Number.isFinite(battery.level) &&
    battery.level <= LOW_BATTERY_LEVEL
  );
}

function roundFps(value: number): number {
  return Math.round(value * 10) / 10;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
