import GUI from 'lil-gui';
import { clock, frameLoop, surface, type Gpu, type Surface } from 'vgpu';

import { createAnimation, type Animation } from './animation';
import { generateField, type StarField } from './field';
import { installFieldInput, type FieldInput } from './input';
import {
  bakeDirt,
  createEffects,
  createResources,
  createTargets,
  DEFAULT_LOOK,
  destroyTargets,
  prewarm,
  renderChain,
  setBindings,
  setLook,
  stepSimulation,
  type Effects,
  type Resources,
  type Targets,
} from './pipeline';

interface RendererOptions {
  readonly canvas: HTMLCanvasElement;
  /** Hosts the lil-gui panel; defaults to the canvas parent. */
  readonly container?: HTMLElement;
}

interface RenderSize {
  width: number;
  height: number;
  dpr: number;
}

interface Settings {
  lensFlare: boolean;
  dirtyGlass: boolean;
  hoverRepel: boolean;
}

const MAX_DPR = 1.6;

function bestEffort(cleanup: () => void): void {
  try {
    cleanup();
  } catch {
    // Teardown must run to completion even when one step throws.
  }
}

export function createRenderer({ canvas, container = canvas.parentElement ?? undefined }: RendererOptions) {
  let disposed = false;
  let gpu: Gpu | undefined;
  let canvasSurface: Surface | undefined;
  let field: StarField | undefined;
  let animation: Animation | undefined;
  let resources: Resources | undefined;
  let effects: Effects | undefined;
  let targets: Targets | undefined;
  let input: FieldInput | undefined;
  let gui: GUI | undefined;
  let observer: ResizeObserver | undefined;
  let resizeFrame = 0;
  let pendingSize: RenderSize | undefined;
  let pixelRatio = 1;
  let lastDpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio;
  const settings: Settings = {
    lensFlare: DEFAULT_LOOK.lensFlare.enabled,
    dirtyGlass: DEFAULT_LOOK.dirtyGlass.enabled,
    hoverRepel: true,
  };

  const applySettings = () => {
    if (disposed || !effects || !animation) return;
    setLook(effects, { lensFlare: settings.lensFlare, dirtyGlass: settings.dirtyGlass });
    animation.setRepel(settings.hoverRepel);
  };

  const applyResize = () => {
    resizeFrame = 0;
    const size = pendingSize;
    pendingSize = undefined;
    if (disposed || !size || !gpu || !effects || !targets || !resources || !animation || !canvasSurface) return;

    try {
      const previousTargets = targets;
      const nextTargets = createTargets(gpu, [
        Math.max(1, Math.round(size.width * size.dpr)),
        Math.max(1, Math.round(size.height * size.dpr)),
      ]);
      try {
        pixelRatio = size.dpr;
        setBindings(effects, nextTargets, resources, { pixelRatio, repelRadius: animation.repelRadius });
      } catch (error) {
        destroyTargets(nextTargets);
        throw error;
      }
      targets = nextTargets;
      destroyTargets(previousTargets);
      // Repel offsets are in screen space; a new size invalidates them.
      animation.resetMotion();
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
    const rect = canvas.getBoundingClientRect();
    resize({
      width: rect.width,
      height: rect.height,
      dpr: Math.min(MAX_DPR, Math.max(1, window.devicePixelRatio || 1)),
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
    for (const cleanup of [
      () => observer?.disconnect(),
      () => {
        if (typeof window !== 'undefined') window.removeEventListener('resize', onWindowResize);
      },
      () => input?.dispose(),
      () => gui?.destroy(),
      () => gpu?.dispose(),
    ]) {
      bestEffort(cleanup);
    }
  };

  const initialize = async () => {
    const { init } = await import('vgpu');
    if (disposed) return;

    // The star draw reads the simulation output from a vertex-stage storage
    // buffer; compatibility-mode devices grant none unless asked.
    const nextGpu = await init({ requiredLimits: { maxStorageBuffersInVertexStage: 1 } });
    if (disposed) {
      nextGpu.dispose();
      return;
    }

    gpu = nextGpu;
    canvasSurface = surface(gpu, canvas, { dpr: [1, MAX_DPR] });
    pixelRatio = Math.min(MAX_DPR, Math.max(1, window.devicePixelRatio || 1));
    const reducedMotion =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    field = generateField();
    animation = createAnimation(field, { reducedMotion });
    settings.hoverRepel = animation.repelEnabled;
    resources = createResources(gpu, field);
    effects = createEffects(gpu, field, resources);
    targets = createTargets(gpu, canvasSurface.size);
    setBindings(effects, targets, resources, { pixelRatio, repelRadius: animation.repelRadius });
    await prewarm(effects, targets, resources, canvasSurface);
    if (disposed) return;
    bakeDirt(gpu, effects, resources);

    input = installFieldInput(canvas, animation);
    gui = createGui(container, settings, {
      replay: () => animation?.replay(),
      apply: applySettings,
    });
    observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure);
    observer?.observe(canvas);
    window.addEventListener('resize', onWindowResize);
    measure();

    const gpuClock = clock(gpu);
    frameLoop(gpu, (currentFrame) => {
      if (disposed || !effects || !targets || !resources || !field || !animation || !canvasSurface) return;
      stepSimulation(effects, resources, field, animation, gpuClock.deltaTime);
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

function createGui(
  container: HTMLElement | undefined,
  settings: Settings,
  actions: { replay: () => void; apply: () => void },
): GUI {
  if (!container) throw new Error('Spiral Galaxy needs a GUI container');

  let gui: GUI | undefined;
  try {
    gui = new GUI({ title: 'Spiral Galaxy', container, width: 210 });
    Object.assign(gui.domElement.style, {
      position: 'absolute',
      top: '16px',
      right: '16px',
      zIndex: '10',
    });
    gui.add(actions, 'replay').name('Replay intro');
    gui.add(settings, 'lensFlare').name('Lens flare').onChange(actions.apply);
    gui.add(settings, 'dirtyGlass').name('Dirty glass').onChange(actions.apply);
    gui.add(settings, 'hoverRepel').name('Hover repel').onChange(actions.apply);
    return gui;
  } catch (error) {
    bestEffort(() => gui?.destroy());
    throw error;
  }
}
