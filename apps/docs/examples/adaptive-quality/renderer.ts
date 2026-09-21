import { clock, frameLoop, init, surface, type FrameLoopHandle, type Gpu, type Surface } from 'vgpu';

import { tierDpr, type QualityPreference, type QualityState, type QualityTier } from './quality';
import { createQualityController, type QualityController } from './quality-controller';
import type { QualitySignals } from './quality-signals';
import { createScene, type Scene } from './scene';

export interface RendererOptions {
  readonly canvas: HTMLCanvasElement;
  /** Defaults to `auto`: start High, downgrade once if a signal asks for it. */
  readonly initialPreference?: QualityPreference;
  /** Same-origin copy of detect-gpu's benchmark tables. Omit to use detect-gpu's CDN default. */
  readonly benchmarksUrl?: string;
  readonly onError?: (error: unknown) => void;
}

export interface Renderer {
  /** Settles once the first tier is on screen. Cancellation is not an error. */
  readonly ready: Promise<void>;
  getState(): QualityState;
  subscribe(listener: (state: QualityState) => void): () => void;
  setPreference(preference: QualityPreference): Promise<void>;
  dispose(): void;
}

export function createRenderer(options: RendererOptions): Renderer {
  const { canvas } = options;
  let disposed = false;
  let gpu: Gpu | undefined;
  let output: Surface | undefined;
  let controller: QualityController<Scene> | undefined;
  let loop: FrameLoopHandle | undefined;
  let observer: ResizeObserver | undefined;
  let resizeFrame = 0;
  let pendingResize = false;
  let signals: QualitySignals | undefined;
  let signalsScheduled = false;
  let signalsGeneration = 0;
  let signalsFrame = 0;
  let signalsTask: ReturnType<typeof setTimeout> | undefined;
  let lastDpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio;
  let preference: QualityPreference = options.initialPreference ?? 'auto';
  const listeners = new Set<(state: QualityState) => void>();
  let latestState: QualityState = initialState(preference);

  const report = (error: unknown) => {
    if (disposed) return;
    if (options.onError) options.onError(error);
    else console.error(error);
  };

  // ---- sizing: the surface is manual so each tier can pick its own device pixel ratio.
  const physicalSize = (tier: QualityTier): readonly [number, number] | undefined => {
    const { width, height } = canvas.getBoundingClientRect();
    if (width <= 0 || height <= 0) return undefined;
    const dpr = tierDpr(tier, typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1);
    return [Math.max(1, Math.round(width * dpr)), Math.max(1, Math.round(height * dpr))];
  };
  const applyResize = () => {
    resizeFrame = 0;
    pendingResize = false;
    if (disposed || !output || !controller) return;
    const scene = controller.active;
    const size = physicalSize(scene?.tier ?? latestState.effective);
    if (!size) return;
    try {
      output.resize(size);
      scene?.resize(output.size);
      signals?.resetHealth();
    } catch (error) {
      report(error);
    }
  };
  const measure = () => {
    if (disposed) return;
    pendingResize = true;
    if (!resizeFrame) resizeFrame = requestAnimationFrame(applyResize);
  };
  const onWindowResize = () => {
    if (window.devicePixelRatio === lastDpr) return;
    lastDpr = window.devicePixelRatio;
    measure();
  };

  // ---- signals: armed after the first presented High frame, disposed after the downgrade.
  const cancelSignals = () => {
    signalsGeneration += 1;
    signals?.dispose();
    signals = undefined;
    signalsScheduled = false;
    if (signalsFrame) cancelAnimationFrame(signalsFrame);
    if (signalsTask !== undefined) clearTimeout(signalsTask);
    signalsFrame = 0;
    signalsTask = undefined;
  };
  const signalsWanted = () =>
    !disposed && latestState.preference === 'auto' && latestState.effective === 'high';
  const scheduleSignals = () => {
    if (!signalsWanted() || signals || signalsScheduled) return;
    signalsScheduled = true;
    const generation = signalsGeneration;
    // One frame plus a macrotask: the first High frame has been presented before any of this loads.
    signalsFrame = requestAnimationFrame(() => {
      signalsFrame = 0;
      signalsTask = setTimeout(() => {
        signalsTask = undefined;
        void startSignals(generation);
      }, 0);
    });
  };
  const startSignals = async (generation: number) => {
    try {
      const { createQualitySignals } = await import('./quality-signals');
      if (generation !== signalsGeneration || !signalsWanted()) return;
      signalsScheduled = false;
      signals = createQualitySignals({
        benchmarksUrl: options.benchmarksUrl,
        onDowngrade(reason) {
          if (generation !== signalsGeneration || !controller) return;
          void controller.downgrade(reason).catch(report);
        },
      });
    } catch (error) {
      if (generation === signalsGeneration) signalsScheduled = false;
      // Signals are advisory: a failed import leaves High on screen.
      report(error);
    }
  };

  const publish = (state: QualityState) => {
    latestState = state;
    if (!signalsWanted()) cancelSignals();
    for (const listener of listeners) listener(state);
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    cancelSignals();
    if (resizeFrame) cancelAnimationFrame(resizeFrame);
    observer?.disconnect();
    if (typeof window !== 'undefined') window.removeEventListener('resize', onWindowResize);
    loop?.stop();
    controller?.destroy();
    gpu?.dispose();
    listeners.clear();
  };

  const initialize = async () => {
    const nextGpu = await init();
    if (disposed) {
      nextGpu.dispose();
      return;
    }
    gpu = nextGpu;
    const canvasSurface = surface(gpu, canvas, {
      autoResize: false,
      dpr: tierDpr(latestState.effective, window.devicePixelRatio || 1),
    });
    output = canvasSurface;
    const qualityController = createQualityController<Scene>({
      initialPreference: preference,
      createTier: (tier) => createScene(gpu!, canvasSurface, tier),
      onActivate: (tier, scene) => {
        // Resize before the swap so the new tier's first frame is already at its own resolution.
        const size = physicalSize(tier);
        if (size) canvasSurface.resize(size);
        scene.resize(canvasSurface.size);
      },
    });
    controller = qualityController;
    qualityController.subscribe(publish);
    await qualityController.ready;
    if (disposed) return;
    publish(qualityController.state);

    observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure);
    observer?.observe(canvas);
    window.addEventListener('resize', onWindowResize);

    const time = clock(gpu);
    loop = frameLoop(gpu, (currentFrame) => {
      const scene = qualityController.active;
      if (disposed || !scene) return;
      if (pendingResize) applyResize();
      scene.render(currentFrame, time.time);
      signals?.recordFrame({
        deltaMs: time.deltaTime * 1_000,
        active: signalsWanted() && document.visibilityState === 'visible',
        rendered: true,
      });
      scheduleSignals();
    });
  };

  const ready = initialize().catch((error: unknown) => {
    if (disposed) return;
    dispose();
    throw error;
  });

  return {
    ready,
    getState: () => latestState,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setPreference(next) {
      preference = next;
      if (!controller) {
        latestState = initialState(next);
        return Promise.resolve();
      }
      return controller.setPreference(next).catch(report);
    },
    dispose,
  };
}

function initialState(preference: QualityPreference): QualityState {
  return {
    preference,
    effective: preference === 'low' ? 'low' : 'high',
    reason: preference === 'auto' ? 'initial' : 'forced',
  };
}
