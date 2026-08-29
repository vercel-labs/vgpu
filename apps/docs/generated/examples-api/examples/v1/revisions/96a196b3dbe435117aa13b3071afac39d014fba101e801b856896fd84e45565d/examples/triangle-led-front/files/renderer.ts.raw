import GUI from 'lil-gui';
import { clock, frameLoop, surface, type Gpu, type Surface } from 'vgpu';
import { createHeroRenderer, type HeroRenderer } from './scene-renderer';
import { DEFAULT_BRUSH, canonicalTriangleGeometry, type RenderSize } from './settings';
import { brushState, heroStateForActiveClick, simulationBrushState } from './sim-sizing';
import { DEFAULT_TRIANGLE_LED_CONTROLS, isTriangleLedMode, type TriangleLedControls, type TriangleLedMode } from './types';

interface RendererOptions {
  readonly canvas: HTMLCanvasElement;
  readonly initialControls?: Readonly<TriangleLedControls>;
}

export function createRenderer(options: RendererOptions) {
  let disposed = false;
  let gpu: Gpu | undefined;
  let canvasSurface: Surface | undefined;
  let scene: HeroRenderer | undefined;
  let gui: GUI | undefined;
  let refreshGui: (() => void) | undefined;
  let loop: { stop(): void } | undefined;
  let observer: ResizeObserver | undefined;
  let input: ReturnType<typeof installCanvasInput> | undefined;
  let resizeFrame = 0;
  let resizeGeneration = 0;
  let pendingSize: RenderSize | undefined;
  let lastDpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio;
  const initialMode = options.initialControls?.mode ?? DEFAULT_TRIANGLE_LED_CONTROLS.mode;
  let mode = isTriangleLedMode(initialMode) ? initialMode : DEFAULT_TRIANGLE_LED_CONTROLS.mode;
  const guiState: { mode: TriangleLedMode } = { mode };

  const fail = (error: unknown): never => {
    dispose();
    throw error;
  };
  const applyResize = () => {
    resizeFrame = 0;
    const size = pendingSize;
    pendingSize = undefined;
    if (disposed || !size || !scene || !canvasSurface) return;
    const generation = ++resizeGeneration;
    try {
      scene.rebuild({ width: size.width, height: size.height, dpr: canvasSurface.dpr });
      scene.setOutputTarget(canvasSurface);
      void scene.prewarm().catch((error: unknown) => {
        if (disposed || generation !== resizeGeneration) return;
        fail(error);
      });
    } catch (error) {
      if (disposed || generation !== resizeGeneration) return;
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
    resize({ width: rect.width, height: rect.height });
  };
  const onWindowResize = () => {
    if (window.devicePixelRatio === lastDpr) return;
    lastDpr = window.devicePixelRatio;
    measure();
  };
  const setControls = (next: Readonly<TriangleLedControls>) => {
    if (disposed || !isTriangleLedMode(next.mode) || next.mode === mode) return;
    mode = next.mode;
    guiState.mode = mode;
    refreshGui?.();
    scene?.setHero(heroStateForActiveClick(mode));
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    resizeGeneration++;
    loop?.stop();
    loop = undefined;
    if (resizeFrame) cancelAnimationFrame(resizeFrame);
    resizeFrame = 0;
    pendingSize = undefined;
    observer?.disconnect();
    observer = undefined;
    if (typeof window !== 'undefined') window.removeEventListener('resize', onWindowResize);
    input?.dispose();
    input = undefined;
    gui?.destroy();
    gui = undefined;
    refreshGui = undefined;
    scene?.destroy();
    scene = undefined;
    canvasSurface?.dispose();
    canvasSurface = undefined;
    gpu?.dispose();
    gpu = undefined;
  };
  const initialize = async () => {
    const { init } = await import('vgpu');
    if (disposed) return;
    const nextGpu = await init();
    if (disposed) { nextGpu.dispose(); return; }
    gpu = nextGpu;
    canvasSurface = surface(gpu, options.canvas, { dpr: [1, 2] });
    const nextScene = createHeroRenderer(gpu, { theme: 'dark', css: cssSizeOf(options.canvas, canvasSurface.dpr) });
    scene = nextScene;
    nextScene.setOutputTarget(canvasSurface);
    nextScene.setHero(heroStateForActiveClick(mode));
    await nextScene.prewarm();
    if (disposed) { nextScene.destroy(); return; }
    ({ gui, refresh: refreshGui } = buildGui(options.canvas.parentElement, guiState, setControls));
    input = installCanvasInput(options.canvas);
    observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure);
    observer?.observe(options.canvas);
    window.addEventListener('resize', onWindowResize);
    measure();
    const time = clock(gpu);
    loop = frameLoop(gpu, (currentFrame) => {
      if (disposed || !scene || !input || !gpu) return;
      scene.setBrush(input.brush());
      scene.setRgbDeployActive(input.rgbDeployActive());
      scene.renderFrame(currentFrame, { time: time.time, dt: time.deltaTime });
    });
  };
  const ready = initialize().catch((error: unknown) => {
    if (disposed) return;
    fail(error);
  });
  return { ready, setControls, resize, dispose };
}

function buildGui(
  container: HTMLElement | null,
  state: { mode: TriangleLedMode },
  setControls: (controls: TriangleLedControls) => void,
) {
  const gui = new GUI({ title: 'Triangle LEDs', container: container ?? undefined, width: 180 });
  Object.assign(gui.domElement.style, {
    position: 'absolute',
    top: '16px',
    right: '16px',
    zIndex: '10',
  });
  const controller = gui.add(state, 'mode', {
    Default: -1,
    'Edge 1': 0,
    'Edge 2': 1,
    'Edge 3': 2,
  }).name('Mode').onChange((value: number) => {
    if (isTriangleLedMode(value)) setControls({ mode: value });
  });
  return { gui, refresh: () => controller.updateDisplay() };
}

function cssSizeOf(canvas: HTMLCanvasElement, dpr: Surface['dpr']) {
  const rect = canvas.getBoundingClientRect();
  return {
    width: Math.max(1, rect.width || canvas.clientWidth || canvas.width / dpr),
    height: Math.max(1, rect.height || canvas.clientHeight || canvas.height / dpr),
    dpr,
  };
}

function installCanvasInput(canvas: HTMLCanvasElement) {
  let currentBrush = brushState(DEFAULT_BRUSH);
  let deployActive = false;
  let activePointer: number | undefined;
  const previousTouchAction = canvas.style.touchAction;
  canvas.style.touchAction = 'none';

  const leave = () => { currentBrush = brushState(DEFAULT_BRUSH); };
  const update = (event: PointerEvent) => {
    if (!event.isPrimary || (activePointer !== undefined && event.pointerId !== activePointer)) return false;
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(1, rect.width);
    const height = Math.max(1, rect.height);
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    if (x < 0 || x > width || y < 0 || y > height) { leave(); return false; }
    currentBrush = simulationBrushState(DEFAULT_BRUSH, {
      x,
      y,
      active: true,
      inside: isPointInsideTriangle({ x, y }, { width, height }),
      isMouse: event.pointerType === 'mouse',
    }, height);
    return true;
  };
  const down = (event: PointerEvent) => {
    if (!event.isPrimary || activePointer !== undefined) return;
    activePointer = event.pointerId;
    canvas.setPointerCapture?.(event.pointerId);
    update(event);
  };
  const move = (event: PointerEvent) => { update(event); };
  const up = (event: PointerEvent) => {
    if (!event.isPrimary || (activePointer !== undefined && event.pointerId !== activePointer)) return;
    if (update(event)) deployActive = !deployActive;
    if (canvas.hasPointerCapture?.(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    activePointer = undefined;
  };
  const cancel = (event: PointerEvent) => {
    if (event.pointerId !== activePointer) return;
    if (canvas.hasPointerCapture?.(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    activePointer = undefined;
    leave();
  };
  const pointerLeave = () => { if (activePointer === undefined) leave(); };
  canvas.addEventListener('pointerdown', down);
  canvas.addEventListener('pointermove', move, { passive: true });
  canvas.addEventListener('pointerup', up, { passive: true });
  canvas.addEventListener('pointercancel', cancel);
  canvas.addEventListener('pointerleave', pointerLeave);
  return {
    brush: () => currentBrush,
    rgbDeployActive: () => deployActive,
    dispose() {
      canvas.removeEventListener('pointerdown', down);
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerup', up);
      canvas.removeEventListener('pointercancel', cancel);
      canvas.removeEventListener('pointerleave', pointerLeave);
      if (activePointer !== undefined && canvas.hasPointerCapture?.(activePointer)) canvas.releasePointerCapture(activePointer);
      activePointer = undefined;
      canvas.style.touchAction = previousTouchAction;
    },
  };
}

function isPointInsideTriangle(
  point: { x: number; y: number },
  size: { width: number; height: number },
) {
  const { top, left, right } = canonicalTriangleGeometry(size);
  const side = (a: typeof top, b: typeof top) =>
    (b.x - a.x) * (point.y - a.y) - (b.y - a.y) * (point.x - a.x);
  const a = side(top, left);
  const b = side(left, right);
  const c = side(right, top);
  return (a <= 0 && b <= 0 && c <= 0) || (a >= 0 && b >= 0 && c >= 0);
}
