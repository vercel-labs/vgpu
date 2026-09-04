import type { Frame, Gpu, Surface, Target } from "vgpu";
import { clock, frameLoop, init, surface } from "vgpu";
import {
  Device,
  validateRequiredFeatures,
  type CreateDeviceOptions,
  type VGPUAdapter,
} from "vgpu/core";

import type {
  BrowserRendererOptions,
  ExampleRenderer,
  RenderSize,
} from "@/lib/example-renderer";
import { prismOptionalFeatures } from "./runtime/capabilities";
import {
  createPrismDebugPreviewRelay,
  NOOP_PRISM_DEBUG_PREVIEW_BRIDGE,
} from "./debug/preview-bridge";
import type { PrismDebugPreviewBridge } from "./debug/preview-bridge";
import type { PrismDebugPreviewHost } from "./debug/gpu";
import { viewportWithinCanvas, type NormalizedViewport } from "./scene/framing";
import { createPrismPipelineController } from "./pipeline-controller";
import { lightMeshLayoutForQuality } from "./pipelines/quality";
import { heroRevealProgress } from "./pipelines/shared/presentation/index";
import type {
  PrismDebugSource,
  PrismPipelineMode,
  PrismPipelineQuality,
  PrismQualityPreference,
  PrismQualityReason,
  PrismQualityState,
} from "./pipelines/types";
import {
  automaticPointerPosition,
  createPrismInteraction,
} from "./runtime/interaction";
import { createPrismRuntime, destroyPrismRuntime } from "./runtime/resources";
import {
  setRuntimeControls,
  setRuntimeFramingViewport,
  setRuntimeLampAim,
  setRuntimeOrbit,
} from "./runtime/state";
import type { PrismRuntime } from "./runtime/types";
import type { PrismThumbnailOptions } from "./thumbnail";
import { DEFAULT_PRISM_CONTROLS, type PrismControls } from "./types";
import type {
  PrismPerformanceReport,
  PrismPerformanceRunOptions,
} from "./performance/types";
import type { PrismPerformanceSampler } from "./performance/sampler";
import type {
  PrismAutoQualityController,
  PrismAutoQualityControllerOptions,
  PrismQualityLogger,
} from "./performance/auto-quality";

export type { PrismThumbnailOptions } from "./thumbnail";

/** Keep thumbnail-only scene code outside the interactive homepage chunk. */
export async function renderThumbnail(
  gpu: Gpu,
  output: Target,
  options: PrismThumbnailOptions = {}
): Promise<void> {
  const thumbnail = await import("./thumbnail");
  return thumbnail.renderThumbnail(gpu, output, options);
}

export interface PrismRenderer extends ExampleRenderer<PrismControls> {
  /** Stable bridge identity; GPU-backed previews can replace its internals. */
  readonly debugBridge: PrismDebugPreviewBridge;
  debugSources(): readonly PrismDebugSource[];
  getQualityState(): PrismQualityState;
  subscribeQuality(listener: (state: PrismQualityState) => void): () => void;
  setMode(mode: PrismPipelineMode): Promise<void>;
  setQualityPreference(preference: PrismQualityPreference): Promise<void>;
  /** Available only when the renderer was created for `?prism-perf`. */
  measurePerformance(
    options?: PrismPerformanceRunOptions
  ): Promise<PrismPerformanceReport>;
}
const DUST_FPS = 30;
const DESKTOP_MAX_RENDER_FPS = 90;
const LOW_QUALITY_MAX_RENDER_FPS = 60;
const MOBILE_MAX_RENDER_FPS = 30;
const LOW_QUALITY_DPR = 1;
const OFFSCREEN_ROOT_MARGIN_PX = 256;
const PERFORMANCE_DPR_QUERY = "prism-perf-dpr";
const MOBILE_AUTO_POINTER_QUERY = "(max-width: 767px)";
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/** Lets vgpu request its device from the adapter already probed for features. */
function reuseBrowserAdapter(adapter: GPUAdapter): VGPUAdapter {
  return {
    async requestDevice(options: CreateDeviceOptions = {}) {
      validateRequiredFeatures(adapter.features, options.requiredFeatures);
      const device = await adapter.requestDevice({
        label: options.label,
        requiredFeatures: options.requiredFeatures,
        requiredLimits: options.requiredLimits,
      });
      return new Device(device, adapter.info ?? null);
    },
  };
}

export interface PrismBrowserRendererOptions
  extends BrowserRendererOptions<PrismControls> {
  /** DOM slot whose canvas-relative bounds should contain the prism. */
  readonly framingElement?: HTMLElement;
  /** Explicit theme selected by the React integration layer. */
  readonly initialMode: PrismPipelineMode;
  /** User quality preference; Auto starts High and is the default. */
  readonly initialQuality?: PrismQualityPreference;
  /** Loads preview-only WebGPU code; must only be enabled for `?debug`. */
  readonly debugPreviews?: boolean;
  /** Dynamically loads the deterministic sampler for `?prism-perf`. */
  readonly performanceSampling?: boolean;
  /** Test seam for the post-first-frame dynamic import. */
  loadAutoQuality?(): Promise<{
    createPrismAutoQualityController(
      options: PrismAutoQualityControllerOptions
    ): PrismAutoQualityController;
  }>;
  /** Test seam for structured Auto-quality diagnostics. */
  readonly qualityLogger?: PrismQualityLogger;
}

export function createRenderer(
  options: PrismBrowserRendererOptions
): PrismRenderer {
  const performanceDpr = options.performanceSampling
    ? requestedPerformanceDpr(window.location?.search)
    : undefined;
  const debugRelay = options.debugPreviews
    ? createPrismDebugPreviewRelay()
    : undefined;
  const qualityLogger = options.qualityLogger ?? console;
  let disposed = false;
  let reportedError = false;
  let controls: PrismControls =
    options.initialControls ?? DEFAULT_PRISM_CONTROLS;
  let gpu: Gpu | undefined;
  let gpuClock: ReturnType<typeof clock> | undefined;
  let canvasSurface: Surface | undefined;
  let runtime: PrismRuntime | undefined;
  let pipelineController:
    | ReturnType<typeof createPrismPipelineController>
    | undefined;
  let debugHost: PrismDebugPreviewHost | undefined;
  let performanceSampler: PrismPerformanceSampler | undefined;
  let requestedMode = options.initialMode;
  let qualityPreference = options.initialQuality ?? "auto";
  let requestedQuality: PrismPipelineQuality =
    qualityPreference === "low" ? "low" : "high";
  let requestedQualityReason: PrismQualityReason =
    qualityPreference === "auto" ? "initial" : "forced";
  let effectiveQuality = requestedQuality;
  let effectiveQualityReason: PrismQualityReason = requestedQualityReason;
  const qualityListeners = new Set<(state: PrismQualityState) => void>();
  let qualityTransition = 0;
  let autoQualityGeneration = 0;
  let autoQualityFrame = 0;
  let autoQualityTask: ReturnType<typeof setTimeout> | undefined;
  let autoQualityScheduled = false;
  let autoQualityController: PrismAutoQualityController | undefined;
  let loop: { stop(): void } | undefined;
  let observer: ResizeObserver | undefined;
  let visibilityObserver: IntersectionObserver | undefined;
  const observeActivity = !options.performanceSampling;
  const pauseWhenInactive = !options.debugPreviews && observeActivity;
  let schedulingReady = false;
  let documentVisible = true;
  let canvasNearViewport = true;
  let resizeFrame = 0;
  let pendingSize: RenderSize | undefined;
  let pendingFraming: NormalizedViewport | undefined;
  let framingPending = false;
  /** Set whenever the picture would differ from the frame already on screen. */
  let pendingPresent = true;
  /** Wakes preview-only passes without forcing the production scene to redraw. */
  let debugPending = false;
  let lastDustTime = -1;
  let renderTimeBudget = 0;
  let hasRenderedCappedFrame = false;
  let presentedQuality: PrismPipelineQuality | undefined;
  let revealStartTime: number | undefined;
  let lastRevealProgress = -1;
  let lastBeamWidthReveal = -1;
  const mobileAutoPointer =
    typeof window.matchMedia === "function"
      ? window.matchMedia(MOBILE_AUTO_POINTER_QUERY)
      : undefined;
  const prefersReducedMotion =
    typeof window.matchMedia === "function" &&
    window.matchMedia(REDUCED_MOTION_QUERY).matches;
  const interaction = createPrismInteraction(options.canvas, () => {
    pendingPresent = true;
  });
  const onPointerMove = (event: PointerEvent) => {
    if (mobileAutoPointer?.matches) return;
    interaction.onPointerMove(event);
  };

  const qualityState = (): PrismQualityState => ({
    preference: qualityPreference,
    effective: effectiveQuality,
    reason: effectiveQualityReason,
  });

  const emitQualityState = () => {
    const state = qualityState();
    for (const listener of qualityListeners) listener(state);
  };

  const setEffectiveQualityState = (
    quality: PrismPipelineQuality,
    reason: PrismQualityReason
  ) => {
    if (
      effectiveQuality === quality &&
      effectiveQualityReason === reason
    )
      return;
    effectiveQuality = quality;
    effectiveQualityReason = reason;
    emitQualityState();
  };

  const handleFailure = (error: unknown) => {
    if (disposed) return;
    if (!reportedError) {
      reportedError = true;
      try {
        options.onError?.(error);
      } catch {
        /* reporting must not block teardown */
      }
    }
    dispose();
  };

  const reportRecoverableFailure = (error: unknown) => {
    if (disposed) return;
    try {
      options.onError?.(error);
    } catch {
      /* reporting a recoverable failure must not affect the active renderer */
    }
  };

  const applyResize = () => {
    resizeFrame = 0;
    const size = pendingSize;
    const framing = pendingFraming;
    const shouldApplyFraming = framingPending;
    pendingSize = undefined;
    pendingFraming = undefined;
    framingPending = false;
    if (disposed || !size || !canvasSurface || !pipelineController || !runtime)
      return;
    try {
      canvasSurface.resize([
        Math.max(1, Math.round(size.width * size.dpr)),
        Math.max(1, Math.round(size.height * size.dpr)),
      ]);
      pipelineController.resize(canvasSurface.size);
      if (shouldApplyFraming) setRuntimeFramingViewport(runtime, framing);
      debugHost?.invalidate();
      pendingPresent = true;
    } catch (error) {
      handleFailure(error);
    }
  };

  const resize = (size: RenderSize) => {
    if (disposed || size.width <= 0 || size.height <= 0) return;
    autoQualityController?.resetHealth();
    pendingSize = size;
    if (!resizeFrame) resizeFrame = requestAnimationFrame(applyResize);
  };

  const currentQuality = (): PrismPipelineQuality =>
    pipelineController?.quality ?? requestedQuality;

  const measureForQuality = (
    quality: PrismPipelineQuality,
    immediate = false
  ) => {
    const rect = options.canvas.getBoundingClientRect();
    if (options.framingElement) {
      pendingFraming = viewportWithinCanvas(
        rect,
        options.framingElement.getBoundingClientRect()
      );
      framingPending = true;
    }
    resize({
      width: rect.width,
      height: rect.height,
      dpr:
        quality === "low"
          ? LOW_QUALITY_DPR
          : performanceDpr ??
            Math.min(2, Math.max(1, window.devicePixelRatio || 1)),
    });
    if (immediate && resizeFrame) {
      cancelAnimationFrame(resizeFrame);
      applyResize();
    }
  };

  const measure = () => measureForQuality(requestedQuality);

  const cancelAutoQuality = () => {
    autoQualityGeneration += 1;
    autoQualityController?.dispose();
    autoQualityController = undefined;
    autoQualityScheduled = false;
    if (autoQualityFrame) cancelAnimationFrame(autoQualityFrame);
    if (autoQualityTask !== undefined) clearTimeout(autoQualityTask);
    autoQualityFrame = 0;
    autoQualityTask = undefined;
  };

  const scheduleAutoQuality = () => {
    if (
      disposed ||
      options.performanceSampling ||
      qualityPreference !== "auto" ||
      effectiveQuality !== "high" ||
      autoQualityController ||
      autoQualityScheduled
    )
      return;
    autoQualityScheduled = true;
    const generation = autoQualityGeneration;
    autoQualityFrame = requestAnimationFrame(() => {
      autoQualityFrame = 0;
      autoQualityTask = setTimeout(() => {
        autoQualityTask = undefined;
        void startAutoQuality(generation);
      }, 0);
    });
  };

  async function startAutoQuality(generation: number): Promise<void> {
    try {
      const loaded = await (options.loadAutoQuality?.() ??
        import("./performance/auto-quality"));
      if (
        disposed ||
        generation !== autoQualityGeneration ||
        qualityPreference !== "auto" ||
        effectiveQuality !== "high"
      )
        return;
      autoQualityScheduled = false;
      autoQualityController = loaded.createPrismAutoQualityController({
        logger: qualityLogger,
        onDowngrade(reason) {
          if (
            disposed ||
            generation !== autoQualityGeneration ||
            qualityPreference !== "auto" ||
            effectiveQuality !== "high"
          )
            return;
          void applyEffectiveQuality("low", reason, generation).catch(() => {
            // The active High pipeline and its DPR were restored by the transition.
          });
        },
      });
    } catch {
      if (generation === autoQualityGeneration) autoQualityScheduled = false;
      // Auto is advisory. A failed deferred import leaves the High image intact.
    }
  }

  async function applyEffectiveQuality(
    quality: PrismPipelineQuality,
    reason: PrismQualityReason,
    generation = autoQualityGeneration
  ): Promise<void> {
    if (disposed || generation !== autoQualityGeneration) return;
    const transition = ++qualityTransition;
    const previousRequestedQuality = requestedQuality;
    const previousRequestedReason = requestedQualityReason;
    requestedQuality = quality;
    requestedQualityReason = reason;

    if (!pipelineController) {
      await ready;
      if (
        disposed ||
        transition !== qualityTransition ||
        generation !== autoQualityGeneration
      )
        return;
    }
    const controller = pipelineController;
    if (!controller) return;
    if (
      controller.quality === quality &&
      controller.requestedQuality === quality
    ) {
      setEffectiveQualityState(quality, reason);
      pendingPresent = true;
      autoQualityController?.resetHealth();
      return;
    }

    if (quality === "low") measureForQuality("low", true);
    try {
      await controller.setQuality(quality);
      if (
        disposed ||
        transition !== qualityTransition ||
        generation !== autoQualityGeneration
      )
        return;
      if (quality === "high") measureForQuality("high", true);
      setEffectiveQualityState(quality, reason);
      pendingPresent = true;
      lastDustTime = -1;
      debugHost?.invalidate();
      if (quality === "low") {
        autoQualityController?.dispose();
        autoQualityController = undefined;
        if (reason !== "forced")
          qualityLogger.info("[Prism quality] Downgraded to Low.", {
            preference: qualityPreference,
            reason,
            from: "high",
            to: "low",
            dpr: LOW_QUALITY_DPR,
          });
      }
    } catch (error) {
      if (
        disposed ||
        transition !== qualityTransition ||
        generation !== autoQualityGeneration
      )
        return;
      requestedQuality = previousRequestedQuality;
      requestedQualityReason = previousRequestedReason;
      void controller.setQuality(effectiveQuality);
      if (quality === "low") measureForQuality(effectiveQuality, true);
      reportRecoverableFailure(error);
      throw error;
    }
  }

  const tick = (currentFrame: Frame) => {
    const pipeline = pipelineController?.pipeline;
    if (disposed || !runtime || !pipeline || !canvasSurface) return;
    const performanceFrame = performanceSampler?.beginFrame(pipeline.mode);
    if (!performanceFrame && mobileAutoPointer?.matches) {
      interaction.setNormalizedPointer(
        automaticPointerPosition(gpuClock?.time ?? 0)
      );
    }
    const aim = performanceFrame
      ? performanceFrame.aim
      : interaction.stepAim();
    const orbit = performanceFrame
      ? performanceFrame.orbit
      : interaction.stepOrbit();
    const reveal = currentRevealProgress();
    const revealProgress = reveal.opacity;
    const beamWidthReveal = reveal.beamWidth;
    const revealChanged = revealProgress !== lastRevealProgress;
    const beamRevealChanged = beamWidthReveal !== lastBeamWidthReveal;
    const updateScene = performanceFrame
      ? performanceFrame.updateScene
      : !!aim || !!orbit || pendingPresent || beamRevealChanged;
    const dustTime =
      performanceFrame?.dustTime ??
      (gpuClock ? Math.floor(gpuClock.time * DUST_FPS) / DUST_FPS : 0);
    const dustAnimating =
      pipeline.mode === "dark" &&
      controls.view === "glass";
    const dustMoved = dustAnimating && dustTime !== lastDustTime;
    const productionActive =
      Boolean(performanceFrame) ||
      updateScene ||
      dustMoved ||
      revealChanged;
    const healthActive =
      !performanceFrame &&
      (productionActive || dustAnimating) &&
      qualityPreference === "auto" &&
      currentQuality() === "high" &&
      documentVisible &&
      canvasNearViewport;
    const healthSample = (rendered: boolean) => {
      autoQualityController?.recordFrame({
        deltaMs: (gpuClock?.deltaTime ?? 0) * 1_000,
        active: healthActive,
        rendered,
        mobile: mobileAutoPointer?.matches === true,
        workload:
          dustAnimating && !updateScene && !revealChanged
            ? "dust"
            : "interactive",
      });
    };
    if (!performanceFrame && !shouldRenderAtCappedRate()) {
      healthSample(false);
      return;
    }
    if (
      !performanceFrame &&
      !updateScene &&
      !dustMoved &&
      !debugPending &&
      !revealChanged
    ) {
      healthSample(false);
      return;
    }
    if (performanceFrame || updateScene || dustMoved || revealChanged) {
      try {
        if (aim) setRuntimeLampAim(runtime, aim[0], aim[1]);
        if (orbit) setRuntimeOrbit(runtime, orbit[0], orbit[1]);
        if (aim || orbit) debugHost?.invalidate();
        pipeline.bind(dustTime, {
          updateScene,
          revealProgress,
          beamWidthReveal,
        });
        pipeline.render(
          currentFrame,
          canvasSurface,
          performanceFrame
            ? { updateScene, profile: performanceFrame.profile }
            : { updateScene }
        );
        pendingPresent = false;
        lastDustTime = dustTime;
        lastRevealProgress = revealProgress;
        lastBeamWidthReveal = beamWidthReveal;
        if (performanceFrame) performanceSampler?.endFrame(performanceFrame);
        else {
          healthSample(true);
          scheduleAutoQuality();
        }
      } catch (error) {
        performanceSampler?.fail(error);
        handleFailure(error);
        return;
      }
    } else healthSample(false);
    debugPending = false;
    try {
      debugHost?.render(currentFrame, gpuClock?.time ?? 0);
    } catch (error) {
      reportRecoverableFailure(error);
    }
  };

  function currentRevealProgress(): {
    readonly opacity: number;
    readonly beamWidth: number;
  } {
    if (options.performanceSampling || prefersReducedMotion) {
      return { opacity: 1, beamWidth: 1 };
    }
    const time = gpuClock?.time ?? 0;
    revealStartTime ??= time;
    return heroRevealProgress(time - revealStartTime);
  }

  /** Caps mobile at 30 FPS and larger layouts at their quality budget. */
  function shouldRenderAtCappedRate(): boolean {
    if (options.performanceSampling) return true;
    if (!hasRenderedCappedFrame) {
      hasRenderedCappedFrame = true;
      return true;
    }
    const delta = gpuClock?.deltaTime ?? 0;
    // A zero delta is possible on the first frame and in deterministic mocks.
    if (!Number.isFinite(delta) || delta <= 0) return true;
    const desktopMaxFps =
      currentQuality() === "low"
        ? LOW_QUALITY_MAX_RENDER_FPS
        : DESKTOP_MAX_RENDER_FPS;
    const renderInterval =
      1 /
      (mobileAutoPointer?.matches ? MOBILE_MAX_RENDER_FPS : desktopMaxFps);
    renderTimeBudget = Math.min(
      renderTimeBudget + delta,
      renderInterval * 2
    );
    if (renderTimeBudget + 1e-9 < renderInterval) return false;
    renderTimeBudget = Math.max(0, renderTimeBudget - renderInterval);
    return true;
  }

  /** Owns the only start/stop transition for the retained frame loop. */
  function reconcileLoop(): void {
    if (!schedulingReady || !gpu) return;
    const shouldRun =
      !disposed &&
      (!pauseWhenInactive || (documentVisible && canvasNearViewport));
    if (shouldRun === Boolean(loop)) return;
    if (!shouldRun) {
      loop?.stop();
      loop = undefined;
      autoQualityController?.resetHealth();
      return;
    }
    // Layout and controls may have changed while no frame was scheduled. A
    // fresh measurement is queued before frameLoop's first rAF, and the dirty
    // flag guarantees that first frame presents the retained state.
    measure();
    pendingPresent = true;
    lastDustTime = -1;
    renderTimeBudget = 0;
    hasRenderedCappedFrame = false;
    loop = frameLoop(gpu, tick);
  }

  const onVisibilityChange = () => {
    if (!observeActivity || disposed) return;
    documentVisible = !document.hidden;
    if (!documentVisible) interaction.onPointerLeave();
    autoQualityController?.resetHealth();
    if (pauseWhenInactive) reconcileLoop();
  };

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    schedulingReady = false;
    cancelAutoQuality();
    qualityListeners.clear();
    loop?.stop();
    loop = undefined;
    if (resizeFrame) cancelAnimationFrame(resizeFrame);
    resizeFrame = 0;
    pendingSize = undefined;
    pendingFraming = undefined;
    framingPending = false;
    observer?.disconnect();
    observer = undefined;
    visibilityObserver?.disconnect();
    visibilityObserver = undefined;
    window.removeEventListener(
      "pointermove",
      onPointerMove as EventListener
    );
    window.removeEventListener("blur", interaction.onPointerLeave);
    if (typeof window !== "undefined")
      window.removeEventListener("resize", measure);
    if (observeActivity && typeof document !== "undefined")
      document.removeEventListener("visibilitychange", onVisibilityChange);

    debugRelay?.setDelegate(NOOP_PRISM_DEBUG_PREVIEW_BRIDGE);
    debugHost?.dispose();
    debugHost = undefined;
    debugRelay?.dispose();
    performanceSampler?.dispose();
    performanceSampler = undefined;

    const controller = pipelineController;
    const ownedRuntime = runtime;
    const ownedSurface = canvasSurface;
    const ownedGpu = gpu;
    pipelineController = undefined;
    runtime = undefined;
    canvasSurface = undefined;
    gpu = undefined;
    gpuClock = undefined;

    const finishResourceCleanup = () => {
      if (ownedRuntime) destroyPrismRuntime(ownedRuntime);
      ownedSurface?.dispose();
      ownedGpu?.dispose();
    };
    const pendingCleanup = controller?.destroy();
    if (pendingCleanup) {
      void pendingCleanup.then(finishResourceCleanup, finishResourceCleanup);
    } else {
      finishResourceCleanup();
    }
  }

  const initialize = async () => {
    const browserAdapter = await Promise.resolve()
      .then(() => navigator.gpu?.requestAdapter())
      .catch(() => undefined);
    if (disposed) return;
    let requiredFeatures: readonly GPUFeatureName[] = [];
    let adapter: VGPUAdapter | undefined;
    if (browserAdapter) {
      requiredFeatures = prismOptionalFeatures(
        browserAdapter.features,
        options.performanceSampling === true
      );
      adapter = reuseBrowserAdapter(browserAdapter);
    }
    const baseInitOptions = adapter ? { adapter } : undefined;
    let nextGpu;
    try {
      nextGpu = await init(
        requiredFeatures.length > 0
          ? { ...baseInitOptions, requiredFeatures }
          : baseInitOptions
      );
    } catch (error) {
      if (requiredFeatures.length === 0) throw error;
      // Adapter capabilities may become stale between the optional probe and
      // device creation. Keep the hero alive on the exact fp16 fallback.
      nextGpu = await init(baseInitOptions);
    }
    if (disposed) {
      nextGpu.dispose();
      return;
    }
    gpu = nextGpu;
    canvasSurface = surface(gpu, options.canvas, {
      autoResize: false,
      dpr:
        requestedQuality === "low"
          ? LOW_QUALITY_DPR
          : performanceDpr ?? [1, 2],
    });
    runtime = createPrismRuntime(gpu, canvasSurface.size, "prism-rainbow", {
      debugEnvironment: options.debugPreviews,
      lightMeshLayout: lightMeshLayoutForQuality(requestedQuality),
    });
    setRuntimeControls(runtime, controls);
    if (options.performanceSampling) {
      try {
        const { createPrismPerformanceSampler } = await import("./performance");
        if (disposed || !gpu || !runtime) return;
        performanceSampler = createPrismPerformanceSampler({ gpu, runtime });
      } catch (error) {
        reportRecoverableFailure(error);
      }
    }
    pipelineController = createPrismPipelineController({
      runtime,
      output: canvasSurface,
      initialMode: requestedMode,
      initialQuality: requestedQuality,
      onActivate: (_mode, quality) => {
        const qualityChanged =
          presentedQuality !== undefined && presentedQuality !== quality;
        presentedQuality = quality;
        pendingPresent = true;
        lastDustTime = -1;
        renderTimeBudget = 0;
        hasRenderedCappedFrame = false;
        setEffectiveQualityState(
          quality,
          quality === requestedQuality
            ? requestedQualityReason
            : effectiveQualityReason
        );
        autoQualityController?.resetHealth();
        if (qualityChanged) measureForQuality(quality);
        debugHost?.invalidate();
      },
    });
    if (options.debugPreviews) {
      try {
        const { createPrismDebugPreviewHost } = await import("./debug/gpu");
        if (disposed || !gpu || !runtime || !pipelineController) return;
        debugHost = createPrismDebugPreviewHost({
          gpu,
          runtime,
          getPipeline: () => pipelineController?.pipeline,
          invalidate: () => {
            debugPending = true;
          },
          onError: reportRecoverableFailure,
        });
        debugRelay?.setDelegate(debugHost.bridge);
      } catch (error) {
        reportRecoverableFailure(error);
      }
    }
    window.addEventListener(
      "pointermove",
      onPointerMove as EventListener,
      { passive: true }
    );
    window.addEventListener("blur", interaction.onPointerLeave);
    observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(measure);
    observer?.observe(options.canvas);
    if (options.framingElement) observer?.observe(options.framingElement);
    window.addEventListener("resize", measure);
    measure();
    await pipelineController.ready;
    if (disposed) return;
    gpuClock = clock(gpu);
    if (observeActivity) {
      documentVisible =
        typeof document === "undefined" ? true : !document.hidden;
      canvasNearViewport = isCanvasNearViewport(options.canvas);
      if (typeof document !== "undefined")
        document.addEventListener("visibilitychange", onVisibilityChange);
      if (typeof IntersectionObserver !== "undefined") {
        visibilityObserver = new IntersectionObserver(
          (entries) => {
            const entry = entries[entries.length - 1];
            if (!entry || disposed) return;
            canvasNearViewport = entry.isIntersecting;
            autoQualityController?.resetHealth();
            if (pauseWhenInactive) reconcileLoop();
          },
          {
            rootMargin: `${OFFSCREEN_ROOT_MARGIN_PX}px 0px`,
            threshold: 0,
          }
        );
        visibilityObserver.observe(options.canvas);
      }
    }
    schedulingReady = true;
    reconcileLoop();
  };

  const ready = initialize().catch((error: unknown) => {
    if (disposed) return;
    handleFailure(error);
    throw error;
  });

  return {
    ready,
    debugBridge: debugRelay?.bridge ?? NOOP_PRISM_DEBUG_PREVIEW_BRIDGE,
    debugSources() {
      return pipelineController?.debugSources() ?? [];
    },
    getQualityState() {
      return qualityState();
    },
    subscribeQuality(listener) {
      if (disposed) return () => {};
      qualityListeners.add(listener);
      return () => qualityListeners.delete(listener);
    },
    async setMode(mode) {
      if (disposed) return;
      requestedMode = mode;
      autoQualityController?.resetHealth();
      if (!pipelineController) {
        await ready;
        return;
      }
      try {
        await pipelineController.setMode(mode);
        if (disposed) return;
        pendingPresent = true;
        lastDustTime = -1;
        autoQualityController?.resetHealth();
        debugHost?.invalidate();
      } catch (error) {
        if (disposed) return;
        // The controller deliberately retains the previous active pipeline
        // when a candidate module or prepare fails. Report and reject the
        // switch without tearing that valid renderer down.
        reportRecoverableFailure(error);
        throw error;
      }
    },
    async setQualityPreference(preference) {
      if (disposed) return;
      cancelAutoQuality();
      const generation = autoQualityGeneration;
      qualityPreference = preference;
      const quality: PrismPipelineQuality =
        preference === "low" ? "low" : "high";
      const reason: PrismQualityReason =
        preference === "auto" ? "initial" : "forced";
      if (effectiveQuality === quality) effectiveQualityReason = reason;
      emitQualityState();
      await applyEffectiveQuality(quality, reason, generation);
    },
    async measurePerformance(measureOptions = {}) {
      if (disposed) throw new Error("Cannot sample a disposed prism renderer.");
      await ready;
      const sampler = performanceSampler;
      const controller = pipelineController;
      const output = canvasSurface;
      if (!sampler || !controller?.pipeline || !output) {
        throw new Error(
          "Prism performance sampling is disabled. Reload with ?prism-perf."
        );
      }
      const previousMode = controller.pipeline.mode;
      const mode = measureOptions.mode ?? previousMode;
      if (mode !== previousMode) {
        requestedMode = mode;
        await controller.setMode(mode);
      }
      try {
        return await sampler.start({
          ...measureOptions,
          mode,
          resolution: output.size,
          invalidate: () => {
            pendingPresent = true;
          },
        });
      } finally {
        if (!disposed && mode !== previousMode && pipelineController) {
          requestedMode = previousMode;
          await pipelineController.setMode(previousMode);
          pendingPresent = true;
          lastDustTime = -1;
        }
      }
    },
    setControls(next) {
      if (disposed) return;
      controls = { ...next };
      pendingPresent = true;
      if (runtime) setRuntimeControls(runtime, controls);
      debugHost?.invalidate();
    },
    invalidate() {
      pendingPresent = true;
      debugHost?.invalidate();
    },
    resize,
    dispose,
  };
}

function requestedPerformanceDpr(search: string | undefined): 1 | 2 | undefined {
  const value = new URLSearchParams(search).get(PERFORMANCE_DPR_QUERY);
  if (value === "1") return 1;
  if (value === "2") return 2;
  return undefined;
}

function isCanvasNearViewport(canvas: HTMLCanvasElement): boolean {
  if (typeof window === "undefined") return true;
  const rect = canvas.getBoundingClientRect();
  const viewportHeight = window.innerHeight;
  if (
    !Number.isFinite(viewportHeight) ||
    !Number.isFinite(rect.top) ||
    !Number.isFinite(rect.bottom)
  )
    return true;
  return (
    rect.bottom >= -OFFSCREEN_ROOT_MARGIN_PX &&
    rect.top <= viewportHeight + OFFSCREEN_ROOT_MARGIN_PX
  );
}
