import type { Surface, Target } from "vgpu";

import type {
  PrismDebugSource,
  PrismPipeline,
  PrismPipelineMode,
  PrismPipelineQuality,
} from "./pipelines/types";
import { resizeRuntime, setRuntimeLightMeshLayout } from "./runtime/state";
import type { PrismRuntime } from "./runtime/types";

type PrismOutput = Surface | Target;

export type PrismPipelineFactory = (
  mode: PrismPipelineMode,
  quality: PrismPipelineQuality,
  runtime: PrismRuntime
) => PrismPipeline | Promise<PrismPipeline>;

export interface PrismPipelineControllerOptions {
  readonly runtime: PrismRuntime;
  readonly output: PrismOutput;
  readonly initialMode: PrismPipelineMode;
  readonly initialQuality?: PrismPipelineQuality;
  readonly createPipeline?: PrismPipelineFactory;
  readonly onActivate?: (
    mode: PrismPipelineMode,
    quality: PrismPipelineQuality
  ) => void;
}

export interface PrismPipelineController {
  readonly ready: Promise<void>;
  readonly pipeline: PrismPipeline | undefined;
  readonly quality: PrismPipelineQuality | undefined;
  readonly requestedMode: PrismPipelineMode;
  readonly requestedQuality: PrismPipelineQuality;
  setMode(mode: PrismPipelineMode): Promise<void>;
  setQuality(quality: PrismPipelineQuality): Promise<void>;
  resize(size: readonly [number, number]): void;
  debugSources(): readonly PrismDebugSource[];
  /** Returns a promise while module loading or prepare still needs the runtime. */
  destroy(): Promise<void> | undefined;
}

let lightPipelineModule:
  | Promise<typeof import("./pipelines/light")>
  | undefined;
let darkPipelineModule: Promise<typeof import("./pipelines/dark")> | undefined;

function loadLightPipelineModule() {
  lightPipelineModule ??= import("./pipelines/light").catch(
    (error: unknown) => {
      lightPipelineModule = undefined;
      throw error;
    }
  );
  return lightPipelineModule;
}

function loadDarkPipelineModule() {
  darkPipelineModule ??= import("./pipelines/dark").catch((error: unknown) => {
    darkPipelineModule = undefined;
    throw error;
  });
  return darkPipelineModule;
}

/** Starts fetching the selected theme pipeline before the GPU is initialized. */
export function preloadPrismPipeline(mode: PrismPipelineMode): void {
  const pending =
    mode === "light" ? loadLightPipelineModule() : loadDarkPipelineModule();
  void pending.catch(() => {
    // The controller reports a retry failure through the renderer's onError.
  });
}

const defaultFactory: PrismPipelineFactory = (mode, quality, runtime) =>
  mode === "light"
    ? loadLightPipelineModule().then(({ createLightPipeline }) =>
        createLightPipeline(runtime, { quality })
      )
    : loadDarkPipelineModule().then(({ createDarkPipeline }) =>
        createDarkPipeline(runtime, { quality })
      );

/**
 * Serializes theme preparation while retaining the current image. A completed
 * candidate is activated only when it still matches the latest requested mode.
 */
export function createPrismPipelineController({
  runtime,
  output,
  initialMode,
  initialQuality = "high",
  createPipeline = defaultFactory,
  onActivate,
}: PrismPipelineControllerOptions): PrismPipelineController {
  let requestedMode = initialMode;
  let requestedQuality = initialQuality;
  let active: PrismPipeline | undefined;
  let activeQuality: PrismPipelineQuality | undefined;
  let preparing: PrismPipeline | undefined;
  let running: Promise<void> | undefined;
  let cleanup: Promise<void> | undefined;
  let disposed = false;

  const run = async () => {
    while (
      !disposed &&
      (active?.mode !== requestedMode || activeQuality !== requestedQuality)
    ) {
      const candidateMode = requestedMode;
      const candidateQuality = requestedQuality;
      let candidate: PrismPipeline;
      try {
        candidate = await createPipeline(
          candidateMode,
          candidateQuality,
          runtime
        );
      } catch (error) {
        if (disposed) return;
        if (
          candidateMode !== requestedMode ||
          candidateQuality !== requestedQuality
        )
          continue;
        throw error;
      }
      if (
        disposed ||
        candidateMode !== requestedMode ||
        candidateQuality !== requestedQuality
      ) {
        candidate.destroy();
        continue;
      }
      preparing = candidate;
      try {
        await candidate.prepare(output);
      } catch (error) {
        candidate.destroy();
        if (preparing === candidate) preparing = undefined;
        if (disposed) return;
        if (
          candidateMode !== requestedMode ||
          candidateQuality !== requestedQuality
        )
          continue;
        throw error;
      }

      if (preparing === candidate) preparing = undefined;
      if (
        disposed ||
        candidateMode !== requestedMode ||
        candidateQuality !== requestedQuality
      ) {
        candidate.destroy();
        continue;
      }

      if (candidate.lightMeshLayout)
        setRuntimeLightMeshLayout(runtime, candidate.lightMeshLayout);
      candidate.resize(runtime.outputSize);
      const previous = active;
      active = candidate;
      activeQuality = candidateQuality;
      previous?.destroy();
      onActivate?.(candidateMode, candidateQuality);
    }
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
      }
    );
    return task;
  };

  const ready = ensureRunning();

  return {
    ready,
    get pipeline() {
      return active;
    },
    get quality() {
      return activeQuality;
    },
    get requestedMode() {
      return requestedMode;
    },
    get requestedQuality() {
      return requestedQuality;
    },
    setMode(mode) {
      if (disposed) return Promise.resolve();
      requestedMode = mode;
      return active?.mode === mode &&
        activeQuality === requestedQuality &&
        !preparing
        ? Promise.resolve()
        : ensureRunning();
    },
    setQuality(quality) {
      if (disposed) return Promise.resolve();
      requestedQuality = quality;
      return active?.mode === requestedMode &&
        activeQuality === quality &&
        !preparing
        ? Promise.resolve()
        : ensureRunning();
    },
    resize(size) {
      if (disposed) return;
      resizeRuntime(runtime, size);
      active?.resize(size);
      preparing?.resize(size);
    },
    debugSources() {
      return active?.debugSources?.() ?? [];
    },
    destroy() {
      if (cleanup) return cleanup;
      if (disposed) return undefined;
      disposed = true;
      active?.destroy();
      active = undefined;
      activeQuality = undefined;
      if (!running) return undefined;
      cleanup = running.then(
        () => undefined,
        () => undefined
      );
      return cleanup;
    },
  };
}
