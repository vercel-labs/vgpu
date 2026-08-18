import type { Gpu, Surface, Target } from 'vgpu';
import { frameLoop, surface } from 'vgpu';

import type { BrowserRendererOptions, ExampleRenderer, RenderSize, ThumbnailOptions } from '../../lib/example-renderer';
import {
  createScene,
  destroyScene,
  prepareScene,
  presentScene,
  resetAccumulation,
  resizeScene,
  setControls,
  setLampArc,
  traceFrame,
  type PrismScene,
} from './scene';
import { DEFAULT_PRISM_CONTROLS, type PrismControls } from './types';

/**
 * Frames after which the running average has converged enough that more rays
 * change nothing visible. The loop then stops submitting work entirely — the
 * canvas keeps its last frame — until something invalidates the estimate.
 */
export const CONVERGED_FRAMES = 900;

export interface PrismRenderer extends ExampleRenderer<PrismControls> {
  /** Frames folded into the current estimate, for the progress readout. */
  accumulated(): number;
}

export interface PrismThumbnailOptions extends ThumbnailOptions {
  readonly controls?: PrismControls;
  readonly lampArc?: number;
}

export function createRenderer(options: BrowserRendererOptions<PrismControls>): PrismRenderer {
  let disposed = false;
  let reportedError = false;
  let controls: PrismControls = options.initialControls ?? DEFAULT_PRISM_CONTROLS;
  let gpu: Gpu | undefined;
  let canvasSurface: Surface | undefined;
  let scene: PrismScene | undefined;
  let prepared = false;
  let loop: { stop(): void } | undefined;
  let observer: ResizeObserver | undefined;
  let resizeFrame = 0;
  let pendingSize: RenderSize | undefined;
  let pointerId: number | undefined;

  const handleFailure = (error: unknown) => {
    if (disposed) return;
    if (!reportedError) {
      reportedError = true;
      try { options.onError?.(error); } catch { /* reporting must not block teardown */ }
    }
    dispose();
  };

  const applyResize = () => {
    resizeFrame = 0;
    const size = pendingSize;
    pendingSize = undefined;
    if (disposed || !size || !canvasSurface || !scene) return;
    try {
      canvasSurface.resize([
        Math.max(1, Math.round(size.width * size.dpr)),
        Math.max(1, Math.round(size.height * size.dpr)),
      ]);
      resizeScene(scene, canvasSurface.size);
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

  /** Vertical drag swings the lamp along its arc; the estimate starts over. */
  const aimFromPointer = (event: PointerEvent) => {
    if (!scene) return;
    const rect = options.canvas.getBoundingClientRect();
    if (rect.height <= 0) return;
    setLampArc(scene, 1 - (event.clientY - rect.top) / rect.height);
  };

  const onPointerDown = (event: PointerEvent) => {
    if (!event.isPrimary) return;
    pointerId = event.pointerId;
    options.canvas.setPointerCapture(event.pointerId);
    aimFromPointer(event);
  };
  const onPointerMove = (event: PointerEvent) => {
    if (pointerId !== event.pointerId) return;
    aimFromPointer(event);
  };
  const onPointerUp = (event: PointerEvent) => {
    if (pointerId !== event.pointerId) return;
    if (options.canvas.hasPointerCapture(event.pointerId)) options.canvas.releasePointerCapture(event.pointerId);
    pointerId = undefined;
  };

  const tick = () => {
    if (disposed || !scene || !canvasSurface || !prepared) return;
    if (scene.accumulated >= CONVERGED_FRAMES) return;
    try {
      traceFrame(scene);
      presentScene(scene, canvasSurface);
    } catch (error) {
      handleFailure(error);
    }
  };

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    loop?.stop();
    loop = undefined;
    if (resizeFrame) cancelAnimationFrame(resizeFrame);
    resizeFrame = 0;
    pendingSize = undefined;
    observer?.disconnect();
    observer = undefined;
    for (const [name, listener] of pointerListeners) {
      options.canvas.removeEventListener(name, listener as EventListener);
    }
    if (pointerId !== undefined && options.canvas.hasPointerCapture(pointerId)) {
      options.canvas.releasePointerCapture(pointerId);
    }
    pointerId = undefined;
    if (typeof window !== 'undefined') window.removeEventListener('resize', measure);
    if (scene) destroyScene(scene);
    scene = undefined;
    canvasSurface?.dispose();
    canvasSurface = undefined;
    gpu?.dispose();
    gpu = undefined;
  }

  const pointerListeners: readonly [string, (event: PointerEvent) => void][] = [
    ['pointerdown', onPointerDown],
    ['pointermove', onPointerMove],
    ['pointerup', onPointerUp],
    ['pointercancel', onPointerUp],
  ];

  const initialize = async () => {
    const { init } = await import('vgpu');
    if (disposed) return;
    const nextGpu = await init();
    if (disposed) {
      nextGpu.dispose();
      return;
    }
    gpu = nextGpu;
    canvasSurface = surface(gpu, options.canvas, { dpr: [1, 2] });
    scene = createScene(gpu, canvasSurface.size, 'prism-rainbow');
    setControls(scene, controls);
    for (const [name, listener] of pointerListeners) {
      options.canvas.addEventListener(name, listener as EventListener);
    }
    observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure);
    observer?.observe(options.canvas);
    window.addEventListener('resize', measure);
    await prepareScene(scene, canvasSurface);
    if (disposed) return;
    prepared = true;
    loop = frameLoop(gpu, tick);
  };

  const ready = initialize().catch((error: unknown) => {
    if (disposed) return;
    handleFailure(error);
    throw error;
  });

  return {
    ready,
    accumulated: () => scene?.accumulated ?? 0,
    setControls(next) {
      if (disposed) return;
      controls = { ...next };
      if (scene) setControls(scene, controls);
    },
    invalidate() {
      if (scene) resetAccumulation(scene);
    },
    resize,
    dispose,
  };
}

/**
 * Headless render used for the gallery thumbnail and by the Node GPU tests.
 *
 * Nothing here reads the clock: the picture is a function of how many frames
 * were accumulated, so the same `warmupFrames` always produces the same pixels.
 */
export async function renderThumbnail(
  gpu: Gpu,
  output: Target,
  options: PrismThumbnailOptions = {},
): Promise<void> {
  const scene = createScene(gpu, output.size, 'prism-rainbow-thumb');
  try {
    if (options.controls) setControls(scene, options.controls);
    if (options.lampArc !== undefined) setLampArc(scene, options.lampArc);
    await prepareScene(scene, output);
    for (let index = 0; index < (options.warmupFrames ?? 600); index++) traceFrame(scene);
    presentScene(scene, output);
    await gpu.gpu.queue.onSubmittedWorkDone();
    await gpu.settled();
  } finally {
    destroyScene(scene);
  }
}
