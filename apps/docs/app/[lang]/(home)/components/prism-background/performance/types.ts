import type { PrismPipelineMode } from "../pipelines/types";

export const PRISM_PERFORMANCE_FRAMES = 120;
export const PRISM_PERFORMANCE_WARMUP_FRAMES = 16;

export type PrismPerformanceScenario = "pointer" | "dark-dust";

export interface PrismPerformanceRunOptions {
  /** Rendered frames retained after warmup. Defaults to 120. */
  readonly frames?: number;
  /** Deterministic rendered frames discarded before sampling. Defaults to 16. */
  readonly warmupFrames?: number;
  /** Optional pipeline to sample. The previous pipeline is restored afterwards. */
  readonly mode?: PrismPipelineMode;
  /** Workload to drive. Defaults to the existing deterministic pointer path. */
  readonly scenario?: PrismPerformanceScenario;
  /** Reject a stalled/hidden run after this many milliseconds. */
  readonly maxMs?: number;
}

export interface PrismPerformanceSummary {
  /** Unit is inherited from the containing field: milliseconds or bytes. */
  readonly samples: number;
  readonly min: number;
  readonly max: number;
  readonly mean: number;
  readonly p50: number;
  readonly p95: number;
}

export interface PrismPerformancePassReport {
  /** Number of sampled frames in which this pass was encoded. */
  readonly encodedFrames: number;
  /** Timestamp-query results can be fewer than encoded frames when readback lags. */
  readonly gpu?: PrismPerformanceSummary;
}

export interface PrismPerformanceReport {
  readonly version: 1;
  readonly capturedAt: string;
  readonly mode: PrismPipelineMode;
  readonly scenario: PrismPerformanceScenario;
  readonly resolution: readonly [number, number];
  readonly requested: {
    readonly frames: number;
    readonly warmupFrames: number;
  };
  readonly recordedFrames: number;
  readonly capabilities: {
    readonly timestampQuery: boolean;
    readonly rg11b10ufloatRenderable: boolean;
    readonly visibleBloomFormat: GPUTextureFormat;
    readonly particleLightFormat: GPUTextureFormat;
  };
  readonly timing: {
    /** requestAnimationFrame cadence, including browser/display pacing. */
    readonly frameInterval: PrismPerformanceSummary;
    /** CPU time spent updating runtime state, binding, and encoding production passes. */
    readonly cpuEncode: PrismPerformanceSummary;
  };
  readonly lightMesh: {
    readonly rebuilds: number;
    readonly totalUploadedBytes: number;
    readonly bytesPerRebuild: PrismPerformanceSummary;
    readonly build: PrismPerformanceSummary;
    readonly upload: PrismPerformanceSummary;
    readonly total: PrismPerformanceSummary;
  };
  readonly passes: Readonly<Record<string, PrismPerformancePassReport>>;
}

export interface PrismPerformanceBrowserApi {
  readonly ready: Promise<void>;
  readonly latest?: PrismPerformanceReport;
  run(options?: PrismPerformanceRunOptions): Promise<PrismPerformanceReport>;
}

declare global {
  interface Window {
    /** Present only when the homepage was loaded with `?prism-perf`. */
    __prismPerformance?: PrismPerformanceBrowserApi;
  }
}
