import {
  clock,
  frameLoop,
  surface,
  type Gpu,
  type Surface,
} from 'vgpu';

import {
  createEffects,
  createTargets,
  destroyTargets,
  prewarm,
  renderChain,
  setBindings,
  type Orbit,
} from './pipeline';

interface RendererOptions {
  canvas: HTMLCanvasElement;
}

interface RenderSize {
  width: number;
  height: number;
  dpr: number;
}

export function createRenderer(options: RendererOptions) {
  let disposed = false;
  let gpu: Gpu | undefined;
  let canvasSurface: Surface | undefined;
  let effects: ReturnType<typeof createEffects> | undefined;
  let targets: ReturnType<typeof createTargets> | undefined;
  let input: ReturnType<typeof installOrbitInput> | undefined;
  let observer: ResizeObserver | undefined;
  let resizeFrame = 0;
  let pendingSize: RenderSize | undefined;
  let lastDpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio;

  const applyResize = () => {
    resizeFrame = 0;
    const size = pendingSize;
    pendingSize = undefined;
    if (disposed || !size || !gpu || !effects || !targets || !canvasSurface) return;

    try {
      const previousTargets = targets;
      const nextTargets = createTargets(gpu, [
        Math.max(1, Math.round(size.width * size.dpr)),
        Math.max(1, Math.round(size.height * size.dpr)),
      ]);

      try {
        setBindings(effects, nextTargets);
      } catch (error) {
        destroyTargets(nextTargets);
        throw error;
      }

      targets = nextTargets;
      destroyTargets(previousTargets);
    } catch (error) {
      fail(error);
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
      dpr: Math.min(1.6, Math.max(1, window.devicePixelRatio || 1)),
    });
  };

  const onWindowResize = () => {
    if (window.devicePixelRatio === lastDpr) return;
    lastDpr = window.devicePixelRatio;
    measure();
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (resizeFrame) cancelAnimationFrame(resizeFrame);
    observer?.disconnect();
    if (typeof window !== 'undefined') {
      window.removeEventListener('resize', onWindowResize);
    }
    input?.dispose();
    gpu?.dispose();
  };

  const initialize = async () => {
    const { init } = await import('vgpu');
    if (disposed) return;

    const nextGpu = await init();
    if (disposed) {
      nextGpu.dispose();
      return;
    }

    gpu = nextGpu;
    canvasSurface = surface(gpu, options.canvas, { dpr: [1, 1.6] });
    effects = createEffects(gpu);
    targets = createTargets(gpu, canvasSurface.size);
    setBindings(effects, targets);
    await prewarm(effects, targets, canvasSurface);
    if (disposed) return;

    input = installOrbitInput(options.canvas);
    observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure);
    observer?.observe(options.canvas);
    window.addEventListener('resize', onWindowResize);
    measure();

    const gpuClock = clock(gpu);
    frameLoop(gpu, (currentFrame) => {
      if (disposed || !effects || !targets || !canvasSurface || !input) return;
      effects.scene.set({
        params: { pointer: input.update(), time: gpuClock.time },
      });
      renderChain(currentFrame, effects, targets, canvasSurface);
    });
  };

  function fail(error: unknown): never {
    dispose();
    throw error;
  }

  const ready = initialize().catch((error: unknown) => {
    if (disposed) return;
    fail(error);
  });

  return { ready, resize, dispose };
}

function installOrbitInput(canvas: HTMLCanvasElement) {
  let yaw = 0;
  let pitch = 0.05;
  let targetYaw = 0;
  let targetPitch = 0.05;
  let activePointer: number | undefined;
  const previousTouchAction = canvas.style.touchAction;
  canvas.style.touchAction = 'none';

  const down = (event: PointerEvent) => {
    if (!event.isPrimary || activePointer !== undefined) return;
    activePointer = event.pointerId;
    canvas.setPointerCapture?.(event.pointerId);
  };

  const move = (event: PointerEvent) => {
    if (!event.isPrimary || (activePointer !== undefined && event.pointerId !== activePointer)) {
      return;
    }

    const rect = canvas.getBoundingClientRect();
    const x = Math.max(
      0,
      Math.min(1, (event.clientX - rect.left) / Math.max(1, rect.width)),
    );
    const y = Math.max(
      0,
      Math.min(1, (event.clientY - rect.top) / Math.max(1, rect.height)),
    );
    targetYaw = (0.5 - x) * Math.PI * 1.4;
    targetPitch = Math.max(
      -Math.PI * 0.42,
      Math.min(Math.PI * 0.42, (y - 0.5) * Math.PI * 0.7),
    );
  };

  const end = (event: PointerEvent) => {
    if (event.pointerId !== activePointer) return;
    if (canvas.hasPointerCapture?.(event.pointerId)) {
      canvas.releasePointerCapture(event.pointerId);
    }
    activePointer = undefined;
  };

  canvas.addEventListener('pointerdown', down);
  canvas.addEventListener('pointermove', move);
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);

  return {
    update(): Orbit {
      yaw += (targetYaw - yaw) * 0.12;
      pitch += (targetPitch - pitch) * 0.12;
      return [yaw, pitch];
    },
    dispose() {
      canvas.removeEventListener('pointerdown', down);
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerup', end);
      canvas.removeEventListener('pointercancel', end);
      if (activePointer !== undefined && canvas.hasPointerCapture?.(activePointer)) {
        canvas.releasePointerCapture(activePointer);
      }
      activePointer = undefined;
      canvas.style.touchAction = previousTouchAction;
    },
  };
}
