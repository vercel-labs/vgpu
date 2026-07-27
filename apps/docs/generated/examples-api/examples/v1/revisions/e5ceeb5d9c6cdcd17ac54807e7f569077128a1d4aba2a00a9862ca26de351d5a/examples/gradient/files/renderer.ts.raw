import type { Gpu, Surface, Target } from 'vgpu';
import type { BrowserRendererOptions, ExampleRenderer, RenderSize, ThumbnailOptions } from '../../lib/example-renderer';
import fragment from './shader.wgsl';

export function createRenderer(options: BrowserRendererOptions): ExampleRenderer {
  let disposed = false;
  let gpu: Gpu | undefined;
  let surface: Surface | undefined;
  let loop: { stop(): void } | undefined;
  let observer: ResizeObserver | undefined;
  let resizeFrame = 0;
  let pendingSize: RenderSize | undefined;
  let lastDpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio;
  let reportedError = false;

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

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    loop?.stop();
    loop = undefined;
    if (resizeFrame) cancelAnimationFrame(resizeFrame);
    resizeFrame = 0;
    pendingSize = undefined;
    observer?.disconnect();
    observer = undefined;
    if (typeof window !== 'undefined') window.removeEventListener('resize', onWindowResize);
    surface?.dispose();
    surface = undefined;
    gpu?.dispose();
    gpu = undefined;
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
    surface = gpu.surface(options.canvas, { dpr: [1, 2] });
    const effect = gpu.effect(fragment);
    observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure);
    observer?.observe(options.canvas);
    window.addEventListener('resize', onWindowResize);
    measure();
    loop = gpu.frame.loop((frame) => {
      if (disposed || !surface) return;
      effect.set({ uniforms: { time: gpu!.time, resolution: surface.size } });
      frame.pass({ target: surface }, (pass) => pass.draw(effect));
    });
  };

  function handleFailure(error: unknown): void {
    if (disposed) return;
    if (!reportedError) {
      reportedError = true;
      try { options.onError?.(error); } catch { /* error reporting must not block teardown */ }
    }
    dispose();
  }

  const ready = initialize().catch((error: unknown) => {
    if (disposed) return;
    handleFailure(error);
    throw error;
  });

  return { ready, invalidate() {}, resize, dispose };
}

export async function renderThumbnail(
  gpu: Gpu,
  target: Target,
  options: ThumbnailOptions = {},
): Promise<void> {
  try {
    const effect = gpu.effect(fragment);
    effect.set({
      uniforms: {
        time: options.time ?? Math.PI / 4,
        resolution: target.size,
      },
    });
    gpu.frame((frame) => frame.pass({ target }, (pass) => pass.draw(effect)));
  } finally {
    // Always drain and settle, including when encoding throws. allSettled keeps
    // cleanup failures from replacing the original rendering failure.
    await Promise.allSettled([
      Promise.resolve().then(() => gpu.gpu.queue.onSubmittedWorkDone()),
      Promise.resolve().then(() => gpu.settled()),
    ]);
  }
}
