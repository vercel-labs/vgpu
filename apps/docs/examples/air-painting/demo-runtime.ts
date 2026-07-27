/**
 * No-camera visual demo. **ORT is never loaded on this path.**
 *
 * It exists for three honest reasons:
 *
 * 1. The gallery must never ask for a camera on load, so the default state has to
 *    be something that needs no permission.
 * 2. Camera permission can be declined, or there may be no camera at all.
 * 3. It is the only mode that works on a software rasterizer, where the pose
 *    graph cannot complete a `session.run` in useful time.
 *
 * It replays the same canned frame and the same 24 golden `[1,1,17,3]` buffers
 * the Node thumbnail uses, through the same production `wrist.wgsl`,
 * `paint.wgsl` and `composite.wgsl`. It therefore demonstrates the **visuals**
 * and the buffer plumbing, and it demonstrates nothing about ORT interop. The UI
 * labels it exactly that way, and `AirPaintDemoRenderer` deliberately has no
 * access to a session.
 */
import type { Gpu, Surface } from 'vgpu';
import type { BrowserRendererOptions, ExampleRenderer, RenderSize } from '../../lib/example-renderer';
import {
  createFixtureFrame,
  FIXTURE_FRAME_HEIGHT,
  FIXTURE_FRAME_WIDTH,
  fixtureTransform,
  SYNTHETIC_DT,
  syntheticKeypointFrames,
} from './fixtures';
import {
  createKeypointBuffer,
  createVisualPipeline,
  writeKeypoints,
  type VisualPipeline,
} from './visual-pipeline';

export interface AirPaintDemoStatus {
  readonly phase: 'initializing' | 'running' | 'unsupported' | 'error';
  readonly detail?: string;
  /** Golden samples replayed so far, modulo the loop length. */
  readonly step: number;
}

export interface AirPaintDemoOptions extends BrowserRendererOptions {
  readonly onStatus?: (status: AirPaintDemoStatus) => void;
}

export interface AirPaintDemoRenderer extends ExampleRenderer {
  clear(): void;
}

/** Seconds between replayed golden samples; ~15 Hz, the plan's inference floor. */
const STEP_INTERVAL_SECONDS = 1 / 15;
/** Pause at the end of the ribbon before it clears and starts over. */
const LOOP_HOLD_SECONDS = 2.5;

export function createDemoRenderer(options: AirPaintDemoOptions): AirPaintDemoRenderer {
  let disposed = false;
  let reportedError = false;
  let gpu: Gpu | undefined;
  let surface: Surface | undefined;
  let pipeline: VisualPipeline | undefined;
  let keypoints: ReturnType<typeof createKeypointBuffer> | undefined;
  let observer: ResizeObserver | undefined;
  let displayHandle = 0;
  let resizeFrame = 0;
  let pendingSize: RenderSize | undefined;
  let lastDpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio;
  let step = 0;
  let nextStepAtMs: number | undefined;
  let pendingReset = false;

  const golden = syntheticKeypointFrames(fixtureTransform());

  const status = (phase: AirPaintDemoStatus['phase'], detail?: string) => {
    try {
      options.onStatus?.({ phase, detail, step });
    } catch {
      // Status reporting must never break rendering.
    }
  };

  const handleFailure = (error: unknown) => {
    if (disposed || reportedError) return;
    reportedError = true;
    status('error', error instanceof Error ? error.message : String(error));
    try {
      options.onError?.(error);
    } catch {
      // The host's reporter must not mask the original failure.
    }
  };

  const applyResize = () => {
    resizeFrame = 0;
    const size = pendingSize;
    pendingSize = undefined;
    if (disposed || !size || !surface) return;
    try {
      surface.resize([
        Math.max(1, Math.round(size.width * size.dpr)),
        Math.max(1, Math.round(size.height * size.dpr)),
      ]);
    } catch (error) {
      handleFailure(error);
    }
  };
  const resize = (size: RenderSize) => {
    if (disposed || size.width <= 0 || size.height <= 0) return;
    pendingSize = size;
    if (!resizeFrame) resizeFrame = requestAnimationFrame(applyResize);
  };
  const measure = () => {
    const rect = options.canvas.getBoundingClientRect();
    resize({
      width: rect.width,
      height: rect.height,
      dpr: Math.min(2, Math.max(1, window.devicePixelRatio || 1)),
    });
  };
  const onWindowResize = () => {
    if (window.devicePixelRatio === lastDpr) return;
    lastDpr = window.devicePixelRatio;
    measure();
  };

  const drawFrame = (nowMs: number) => {
    displayHandle = 0;
    if (disposed || !pipeline || !surface || !keypoints) return;
    try {
      nextStepAtMs ??= nowMs;
      if (nowMs >= nextStepAtMs) {
        if (step < golden.length) {
          writeKeypoints(keypoints, golden[step]!);
          // Fixed dt: the replay must be identical to the Node thumbnail's.
          pipeline.consumeKeypoints(keypoints, SYNTHETIC_DT, { reset: pendingReset });
          pendingReset = false;
          step++;
          nextStepAtMs = nowMs + STEP_INTERVAL_SECONDS * 1000;
          status('running');
        } else {
          // Loop: clear the mask and break continuity, exactly like the button.
          pipeline.clearMask();
          pendingReset = true;
          step = 0;
          nextStepAtMs = nowMs + LOOP_HOLD_SECONDS * 1000;
        }
      }
      pipeline.renderVisualFrame(surface, {
        dpr: Math.min(2, Math.max(1, window.devicePixelRatio || 1)),
        hasFrame: true,
        showCursor: step > 0,
      });
    } catch (error) {
      handleFailure(error);
      return;
    }
    displayHandle = requestAnimationFrame(drawFrame);
  };

  const ready = (async () => {
    if (typeof navigator === 'undefined' || !navigator.gpu) {
      status('unsupported', 'This example needs WebGPU (Chrome or Edge 121+).');
      throw new Error('WebGPU is not available.');
    }
    status('initializing', 'Starting the visual demo…');
    const { init } = await import('vgpu');
    if (disposed) return;
    gpu = await init();
    if (disposed) return;

    surface = gpu.surface(options.canvas, { autoResize: false });
    pipeline = createVisualPipeline(gpu, {
      sourceWidth: FIXTURE_FRAME_WIDTH,
      sourceHeight: FIXTURE_FRAME_HEIGHT,
      label: 'air-painting-demo',
    });
    keypoints = createKeypointBuffer(gpu, 'air-painting-demo');
    pipeline.writeFrame(createFixtureFrame());

    measure();
    if (typeof ResizeObserver === 'function') {
      observer = new ResizeObserver(measure);
      observer.observe(options.canvas);
    }
    window.addEventListener('resize', onWindowResize);
    displayHandle = requestAnimationFrame(drawFrame);
    status('running', 'Visual demo: synthetic trajectory, no pose model.');
  })().catch((error: unknown) => {
    handleFailure(error);
  });

  return {
    ready,
    invalidate() {
      // Continuous loop; nothing to coalesce.
    },
    resize,
    clear() {
      if (disposed) return;
      try {
        pipeline?.clearMask();
        pendingReset = true;
        step = 0;
        nextStepAtMs = undefined;
      } catch (error) {
        handleFailure(error);
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (displayHandle) cancelAnimationFrame(displayHandle);
      displayHandle = 0;
      if (resizeFrame) cancelAnimationFrame(resizeFrame);
      resizeFrame = 0;
      observer?.disconnect();
      observer = undefined;
      if (typeof window !== 'undefined') window.removeEventListener('resize', onWindowResize);
      void ready.catch(() => undefined).then(() => {
        try {
          keypoints?.dispose();
          pipeline?.dispose();
          surface?.dispose();
        } finally {
          // This mode owns its device outright, so disposing the facade is correct.
          gpu?.dispose();
        }
      });
    },
  };
}
