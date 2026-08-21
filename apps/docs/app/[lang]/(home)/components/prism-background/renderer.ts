import type { Frame, Gpu, Surface, Target } from 'vgpu';
import { frameLoop, surface } from 'vgpu';

import type { BrowserRendererOptions, ExampleRenderer, RenderSize, ThumbnailOptions } from '@/lib/example-renderer';
import {
  createScene,
  destroyScene,
  prepareScene,
  presentScene,
  resizeScene,
  setControls,
  setLampAim,
  setLampArc,
  setOrbit,
  type PrismScene,
} from './scene';
import {
  CAMERA_ORBIT_LERP,
  DEFAULT_PRISM_CONTROLS,
  LAMP_AIM_LERP,
  PRISM_DEFAULT_ARC,
  type PrismControls,
} from './types';

export type PrismRenderer = ExampleRenderer<PrismControls>;

export interface PrismThumbnailOptions extends ThumbnailOptions {
  readonly controls?: PrismControls;
  readonly lampArc?: number;
  readonly orbit?: readonly [number, number];
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
  /** Where the camera is being asked to look, and where it currently looks. */
  let orbitTarget: readonly [number, number] = [0, 0];
  let orbitCurrent: readonly [number, number] = [0, 0];
  /** Requested and rendered lamp positions, both normalized to the viewport. */
  let aimTarget: readonly [number, number] = [PRISM_DEFAULT_ARC, 0.5];
  let aimCurrent: readonly [number, number] = [PRISM_DEFAULT_ARC, 0.5];
  /** Set whenever the picture would differ from the frame already on screen. */
  let pendingPresent = true;

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
      pendingPresent = true;
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

  /** Pointer height swings the source; pointer width chooses its point of impact. */
  const aimFromPointer = (event: PointerEvent) => {
    const rect = options.canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const clampUnit = (value: number) => Math.min(1, Math.max(0, value));
    aimTarget = [
      clampUnit((event.clientY - rect.top) / rect.height),
      clampUnit((event.clientX - rect.left) / rect.width),
    ];
    pendingPresent = true;
  };

  /**
   * Hovering tilts the camera a couple of degrees. It never touches the
   * light mesh: it already lives on a world-space plane inside the prism, so
   * only its camera projection changes.
   */
  const orbitFromPointer = (event: PointerEvent) => {
    const rect = options.canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const clampOrbit = (value: number) => Math.min(1, Math.max(-1, value));
    orbitTarget = [
      clampOrbit(((event.clientX - rect.left) / rect.width) * 2 - 1),
      clampOrbit(((event.clientY - rect.top) / rect.height) * 2 - 1),
    ];
  };

  const onPointerMove = (event: PointerEvent) => {
    if (event.isPrimary === false) return;
    orbitFromPointer(event);
    aimFromPointer(event);
  };
  const onPointerLeave = () => { orbitTarget = [0, 0]; };

  /**
   * Eases the camera towards where the pointer left it. Returns whether it moved
   * far enough to be worth redrawing.
   */
  const stepOrbit = (): boolean => {
    const dx = orbitTarget[0] - orbitCurrent[0];
    const dy = orbitTarget[1] - orbitCurrent[1];
    if (Math.abs(dx) < 1e-4 && Math.abs(dy) < 1e-4) {
      if (orbitCurrent[0] === orbitTarget[0] && orbitCurrent[1] === orbitTarget[1]) return false;
      orbitCurrent = orbitTarget;
      return true;
    }
    orbitCurrent = [orbitCurrent[0] + dx * CAMERA_ORBIT_LERP, orbitCurrent[1] + dy * CAMERA_ORBIT_LERP];
    return true;
  };

  /** Eases both the source angle and its point of impact towards the pointer. */
  const stepAim = (): boolean => {
    const dArc = aimTarget[0] - aimCurrent[0];
    const dTarget = aimTarget[1] - aimCurrent[1];
    if (Math.abs(dArc) < 1e-4 && Math.abs(dTarget) < 1e-4) {
      if (aimCurrent[0] === aimTarget[0] && aimCurrent[1] === aimTarget[1]) return false;
      aimCurrent = aimTarget;
      return true;
    }
    aimCurrent = [
      aimCurrent[0] + dArc * LAMP_AIM_LERP,
      aimCurrent[1] + dTarget * LAMP_AIM_LERP,
    ];
    return true;
  };

  const tick = (currentFrame: Frame) => {
    if (disposed || !scene || !canvasSurface || !prepared) return;
    const aimMoved = stepAim();
    const orbitMoved = stepOrbit();
    if (!aimMoved && !orbitMoved && !pendingPresent) return;
    try {
      if (aimMoved) setLampAim(scene, aimCurrent[0], aimCurrent[1]);
      if (orbitMoved) setOrbit(scene, orbitCurrent[0], orbitCurrent[1]);
      presentScene(scene, canvasSurface, currentFrame);
      pendingPresent = false;
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
    window.removeEventListener('pointermove', onPointerMove as EventListener);
    window.removeEventListener('blur', onPointerLeave);
    if (typeof window !== 'undefined') window.removeEventListener('resize', measure);
    if (scene) destroyScene(scene);
    scene = undefined;
    canvasSurface?.dispose();
    canvasSurface = undefined;
    gpu?.dispose();
    gpu = undefined;
  }

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
    window.addEventListener('pointermove', onPointerMove as EventListener, { passive: true });
    window.addEventListener('blur', onPointerLeave);
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
    setControls(next) {
      if (disposed) return;
      controls = { ...next };
      pendingPresent = true;
      if (scene) setControls(scene, controls);
    },
    invalidate() {
      pendingPresent = true;
    },
    resize,
    dispose,
  };
}

/**
 * Headless render used for the gallery thumbnail and by the Node GPU tests.
 *
 * Nothing here reads the clock or a random seed, so one frame is the final image.
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
    if (options.orbit) setOrbit(scene, options.orbit[0], options.orbit[1]);
    await prepareScene(scene, output);
    presentScene(scene, output);
    await gpu.gpu.queue.onSubmittedWorkDone();
    await gpu.settled();
  } finally {
    destroyScene(scene);
  }
}
