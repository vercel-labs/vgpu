import type { Gpu, Timer } from "vgpu";
import { timer as createGpuTimer } from "vgpu";

import { PARTICLE_LIGHT_FIRST_LEVEL } from "../pipelines/dark/passes/bloom/config";
import {
  bloomFormatForLevel,
  PACKED_BLOOM_FEATURE,
} from "../runtime/capabilities";
import type { PrismPassProfile, PrismPipelineMode } from "../pipelines/types";
import { setRuntimeLampAim, setRuntimeOrbit } from "../runtime/state";
import type { PrismLightMeshMeasurement, PrismRuntime } from "../runtime/types";
import { deterministicDustTime, deterministicPerformanceInput } from "./path";
import { summarizePerformance } from "./statistics";
import {
  PRISM_PERFORMANCE_FRAMES,
  PRISM_PERFORMANCE_WARMUP_FRAMES,
  type PrismPerformancePassReport,
  type PrismPerformanceReport,
  type PrismPerformanceRunOptions,
  type PrismPerformanceScenario,
} from "./types";

const DEFAULT_MAX_MS = 20_000;
const SPAN_SEPARATOR = "/";

export interface PrismPerformanceSampler {
  readonly active: boolean;
  start(
    options: PrismPerformanceRunOptions & {
      readonly mode: PrismPipelineMode;
      readonly resolution: readonly [number, number];
      readonly invalidate: () => void;
    }
  ): Promise<PrismPerformanceReport>;
  beginFrame(mode: PrismPipelineMode): PrismPerformanceFrame | undefined;
  endFrame(frame: PrismPerformanceFrame): void;
  fail(error: unknown): void;
  dispose(): void;
}

export interface PrismPerformanceFrame {
  readonly scenario: PrismPerformanceScenario;
  readonly updateScene: boolean;
  readonly aim?: readonly [number, number];
  readonly orbit?: readonly [number, number];
  readonly dustTime?: number;
  readonly profile: PrismPassProfile;
  readonly startedAt: number;
}

interface ActiveRun {
  readonly id: number;
  readonly mode: PrismPipelineMode;
  readonly scenario: PrismPerformanceScenario;
  readonly resolution: readonly [number, number];
  readonly frames: number;
  readonly warmupFrames: number;
  readonly invalidate: () => void;
  readonly originalAim: readonly [number, number];
  readonly originalOrbit: readonly [number, number];
  readonly frameIntervals: number[];
  readonly cpuEncode: number[];
  readonly meshBuild: number[];
  readonly meshUpload: number[];
  readonly meshBytes: number[];
  readonly passCounts: Map<string, number>;
  readonly gpuPasses: Map<string, number[]>;
  readonly timer?: Timer;
  unsubscribeTimer?: () => void;
  resolve(report: PrismPerformanceReport): void;
  reject(error: Error): void;
  timeout?: ReturnType<typeof setTimeout>;
  frameIndex: number;
  lastFrameAt?: number;
  currentFrame?: InternalFrame;
  samplingComplete: boolean;
}

interface InternalFrame extends PrismPerformanceFrame {
  readonly sampled: boolean;
}

export interface PrismPerformanceSamplerOptions {
  readonly gpu: Gpu;
  readonly runtime: PrismRuntime;
  readonly now?: () => number;
  readonly timerFactory?: (gpu: Gpu) => Timer;
  readonly drain?: () => Promise<void>;
  readonly restoreState?: (
    aim: readonly [number, number],
    orbit: readonly [number, number]
  ) => void;
}

export function createPrismPerformanceSampler({
  gpu,
  runtime,
  now = () => performance.now(),
  timerFactory = createGpuTimer,
  drain = async () => {
    await gpu.gpu.queue.onSubmittedWorkDone();
    await gpu.settled();
  },
  restoreState = (aim, orbit) => {
    setRuntimeLampAim(runtime, aim[0], aim[1]);
    setRuntimeOrbit(runtime, orbit[0], orbit[1]);
  },
}: PrismPerformanceSamplerOptions): PrismPerformanceSampler {
  let disposed = false;
  let nextRunId = 0;
  let active: ActiveRun | undefined;

  const measurementSink = {
    now,
    recordLightMesh(sample: PrismLightMeshMeasurement) {
      const run = active;
      if (!run?.currentFrame?.sampled) return;
      run.meshBuild.push(sample.buildMs);
      run.meshUpload.push(sample.uploadMs);
      run.meshBytes.push(sample.bytes);
    },
  };

  const start: PrismPerformanceSampler["start"] = (options) => {
    if (disposed)
      return Promise.reject(
        new Error("Prism performance sampler has been disposed.")
      );
    if (active)
      return Promise.reject(
        new Error("A prism performance sample is already running.")
      );

    const scenario = options.scenario ?? "pointer";
    if (scenario !== "pointer" && scenario !== "dark-dust") {
      return Promise.reject(
        new Error(`Unknown prism performance scenario: ${String(scenario)}.`)
      );
    }
    if (scenario === "dark-dust" && options.mode !== "dark") {
      return Promise.reject(
        new Error('The "dark-dust" scenario requires the dark pipeline.')
      );
    }

    const frames = integerWithin(
      options.frames ?? PRISM_PERFORMANCE_FRAMES,
      1,
      2_000
    );
    const requestedWarmupFrames = integerWithin(
      options.warmupFrames ?? PRISM_PERFORMANCE_WARMUP_FRAMES,
      0,
      1_000
    );
    // The first dark-dust warmup explicitly fills the retained presentation.
    // Keeping it outside the sample guarantees every recorded frame is dust-only.
    const warmupFrames =
      scenario === "dark-dust"
        ? Math.max(1, requestedWarmupFrames)
        : requestedWarmupFrames;
    const maxMs = integerWithin(options.maxMs ?? DEFAULT_MAX_MS, 500, 120_000);
    let resolve!: (report: PrismPerformanceReport) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<PrismPerformanceReport>((done, fail) => {
      resolve = done;
      reject = fail;
    });

    let gpuTimer: Timer | undefined;
    if (gpu.device.features.has("timestamp-query")) {
      try {
        gpuTimer = timerFactory(gpu);
      } catch {
        gpuTimer = undefined;
      }
    }

    const run: ActiveRun = {
      id: ++nextRunId,
      mode: options.mode,
      scenario,
      resolution: [...options.resolution],
      frames,
      warmupFrames,
      invalidate: options.invalidate,
      originalAim: [runtime.lampArc, runtime.lampTarget],
      originalOrbit: [...runtime.orbit],
      frameIntervals: [],
      cpuEncode: [],
      meshBuild: [],
      meshUpload: [],
      meshBytes: [],
      passCounts: new Map(),
      gpuPasses: new Map(),
      timer: gpuTimer,
      resolve,
      reject,
      frameIndex: 0,
      samplingComplete: false,
    };
    run.unsubscribeTimer = gpuTimer?.onResults((spans) =>
      collectGpuResults(run, spans)
    );
    run.timeout = setTimeout(() => {
      fail(
        new Error(
          `Prism performance sample stalled after ${maxMs}ms (${run.cpuEncode.length}/${frames} frames).`
        )
      );
    }, maxMs);
    active = run;
    runtime.measurementSink = measurementSink;
    options.invalidate();
    return promise;
  };

  function beginFrame(
    mode: PrismPipelineMode
  ): PrismPerformanceFrame | undefined {
    const run = active;
    if (!run || run.samplingComplete) return undefined;
    if (mode !== run.mode) {
      fail(
        new Error(
          `Prism mode changed from ${run.mode} to ${mode} during sampling.`
        )
      );
      return undefined;
    }

    const startedAt = now();
    const sampled = run.frameIndex >= run.warmupFrames;
    if (sampled && run.lastFrameAt !== undefined) {
      run.frameIntervals.push(startedAt - run.lastFrameAt);
    }
    run.lastFrameAt = startedAt;
    const input =
      run.scenario === "pointer"
        ? deterministicPerformanceInput(run.frameIndex, run.frames)
        : undefined;
    const frame: InternalFrame = {
      sampled,
      startedAt,
      scenario: run.scenario,
      updateScene: run.scenario === "pointer" || run.frameIndex === 0,
      ...(input ?? {}),
      ...(run.scenario === "dark-dust"
        ? { dustTime: deterministicDustTime(run.frameIndex) }
        : {}),
      profile: {
        pass(name) {
          if (sampled)
            run.passCounts.set(name, (run.passCounts.get(name) ?? 0) + 1);
          return sampled
            ? run.timer?.span(
                `${run.id}${SPAN_SEPARATOR}${run.frameIndex}${SPAN_SEPARATOR}${name}`
              )
            : undefined;
        },
      },
    };
    run.currentFrame = frame;
    return frame;
  }

  function endFrame(frame: PrismPerformanceFrame): void {
    const run = active;
    if (!run || run.currentFrame !== frame) return;
    if (run.currentFrame.sampled) run.cpuEncode.push(now() - frame.startedAt);
    run.currentFrame = undefined;
    run.frameIndex += 1;
    if (run.frameIndex < run.warmupFrames + run.frames) return;
    run.samplingComplete = true;
    runtime.measurementSink = undefined;
    // The frame-loop submits after this callback returns. Defer the drain so the
    // final timestamp resolve is part of the queue snapshot we wait for.
    setTimeout(() => {
      void drain().then(
        () => complete(run),
        (error) => fail(error)
      );
    }, 0);
  }

  function complete(run: ActiveRun): void {
    if (active !== run) return;
    const passes: Record<string, PrismPerformancePassReport> = {};
    const names = new Set([...run.passCounts.keys(), ...run.gpuPasses.keys()]);
    for (const name of [...names].sort()) {
      const gpuSamples = run.gpuPasses.get(name) ?? [];
      passes[name] = {
        encodedFrames: run.passCounts.get(name) ?? 0,
        ...(gpuSamples.length > 0
          ? { gpu: summarizePerformance(gpuSamples) }
          : {}),
      };
    }
    const totalMesh = run.meshBuild.map(
      (buildMs, index) => buildMs + (run.meshUpload[index] ?? 0)
    );
    const report: PrismPerformanceReport = {
      version: 1,
      capturedAt: new Date().toISOString(),
      mode: run.mode,
      scenario: run.scenario,
      resolution: run.resolution,
      requested: { frames: run.frames, warmupFrames: run.warmupFrames },
      recordedFrames: run.cpuEncode.length,
      capabilities: {
        timestampQuery: !!run.timer,
        rg11b10ufloatRenderable: gpu.device.features.has(
          PACKED_BLOOM_FEATURE
        ),
        visibleBloomFormat: bloomFormatForLevel(gpu.device.features, 0),
        particleLightFormat: bloomFormatForLevel(
          gpu.device.features,
          PARTICLE_LIGHT_FIRST_LEVEL
        ),
      },
      timing: {
        frameInterval: summarizePerformance(run.frameIntervals),
        cpuEncode: summarizePerformance(run.cpuEncode),
      },
      lightMesh: {
        rebuilds: run.meshBuild.length,
        totalUploadedBytes: run.meshBytes.reduce(
          (total, bytes) => total + bytes,
          0
        ),
        bytesPerRebuild: summarizePerformance(run.meshBytes),
        build: summarizePerformance(run.meshBuild),
        upload: summarizePerformance(run.meshUpload),
        total: summarizePerformance(totalMesh),
      },
      passes,
    };
    teardown(run, true);
    run.resolve(report);
  }

  function fail(error: unknown): void {
    const run = active;
    if (!run) return;
    teardown(run, !disposed);
    run.reject(asError(error));
  }

  function teardown(run: ActiveRun, restore: boolean): void {
    if (run.timeout) clearTimeout(run.timeout);
    run.unsubscribeTimer?.();
    run.timer?.dispose();
    if (active === run) active = undefined;
    runtime.measurementSink = undefined;
    if (!restore) return;
    restoreState(run.originalAim, run.originalOrbit);
    run.invalidate();
  }

  return {
    get active() {
      return !!active && !active.samplingComplete;
    },
    start,
    beginFrame,
    endFrame,
    fail,
    dispose() {
      if (disposed) return;
      disposed = true;
      fail(new Error("Prism performance sampler was disposed."));
    },
  };
}

function collectGpuResults(
  run: ActiveRun,
  spans: Readonly<Record<string, number>>
): void {
  for (const [key, milliseconds] of Object.entries(spans)) {
    const [runText, frameText, ...nameParts] = key.split(SPAN_SEPARATOR);
    if (Number(runText) !== run.id) continue;
    const frame = Number(frameText);
    if (frame < run.warmupFrames || frame >= run.warmupFrames + run.frames)
      continue;
    const name = nameParts.join(SPAN_SEPARATOR);
    if (!name) continue;
    const samples = run.gpuPasses.get(name) ?? [];
    samples.push(milliseconds);
    run.gpuPasses.set(name, samples);
  }
}

function integerWithin(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
