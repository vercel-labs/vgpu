import GUI from 'lil-gui';
import { clock, frameLoop, surface, type Gpu } from 'vgpu';

import { createScene, DEFAULT_MODE, MODES, type AaMode } from './scene';

interface RendererOptions {
  readonly canvas: HTMLCanvasElement;
}

export function createRenderer({ canvas }: RendererOptions) {
  let disposed = false;
  let mode: AaMode = DEFAULT_MODE;
  let gpu: Gpu | undefined;
  let scene: ReturnType<typeof createScene> | undefined;
  let gui: GUI | undefined;
  let observer: ResizeObserver | undefined;
  let resizeFrame = 0;
  let pendingSize: readonly [number, number] | undefined;
  let lastDpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio;

  const fail = (error: unknown): never => {
    dispose();
    throw error;
  };
  const applyResize = () => {
    resizeFrame = 0;
    const size = pendingSize;
    pendingSize = undefined;
    if (disposed || !size || !scene) return;
    try {
      scene.resize(size);
    } catch (error) {
      fail(error);
    }
  };
  const measure = () => {
    const { width, height } = canvas.getBoundingClientRect();
    if (disposed || width <= 0 || height <= 0) return;
    const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    pendingSize = [
      Math.max(1, Math.round(width * dpr)),
      Math.max(1, Math.round(height * dpr)),
    ];
    if (!resizeFrame) resizeFrame = requestAnimationFrame(applyResize);
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
    if (typeof window !== 'undefined') window.removeEventListener('resize', onWindowResize);
    gui?.destroy();
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
    const output = surface(gpu, canvas, { dpr: [1, 2] });
    scene = createScene(gpu, output);
    await scene.prewarm();
    if (disposed) return;

    gui = new GUI({
      title: 'Anti-Aliasing',
      container: canvas.parentElement ?? undefined,
      width: 180,
    });
    Object.assign(gui.domElement.style, {
      position: 'absolute',
      top: '16px',
      right: '16px',
      zIndex: '10',
    });
    gui.add({ mode }, 'mode', MODES).name('Mode').onChange((next: AaMode) => {
      mode = next;
    });

    observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure);
    observer?.observe(canvas);
    window.addEventListener('resize', onWindowResize);
    measure();
    const time = clock(gpu);
    frameLoop(gpu, (currentFrame) => {
      if (!disposed && scene) scene.render(currentFrame, mode, time.time);
    });
  };
  const ready = initialize().catch((error: unknown) => {
    if (disposed) return;
    fail(error);
  });

  return { ready, dispose };
}
