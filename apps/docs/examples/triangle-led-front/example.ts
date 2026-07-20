import type { Gpu, Surface, Target } from 'vgpu';
import { createHeroRenderer } from './renderer';
import { DEFAULT_BRUSH } from './settings';
import { brushState, heroStateForActiveClick, simulationBrushState } from './sim-sizing';
import { isPointInsideTriangle } from './triangle-hit';

const INTERACTIVE_SELECTOR = [
  'a',
  'button',
  'input',
  'select',
  'textarea',
  'label',
  '[role="button"]',
  '[contenteditable="true"]',
].join(',');

interface CssSize {
  width: number;
  height: number;
  dpr: number;
}

interface ThumbOptions {
  warmupFrames?: number;
  dt?: number;
  time?: number;
}

export async function run(canvas: HTMLCanvasElement): Promise<() => void> {
  const { init } = await import('vgpu');
  const gpu = await init();
  const surface = gpu.surface(canvas, { dpr: [1, 2] });
  const renderer = createHeroRenderer(gpu, {
    theme: 'dark',
    css: cssSizeOf(canvas, surface.dpr),
  });
  renderer.setOutputTarget(surface);
  await renderer.prewarm();

  let brush = brushState(DEFAULT_BRUSH);
  let rgbDeployActive = false;
  let disposed = false;

  const controller = new AbortController();
  const select = createModeSelect();
  const selectHost = installSelect(canvas, select);
  let sawInitialResize = false;
  const unsubscribeResize = surface.onResize(({ dpr }) => {
    if (!sawInitialResize) {
      sawInitialResize = true;
      return;
    }
    if (disposed) return;
    renderer.rebuild(cssSizeOf(canvas, dpr));
    renderer.setOutputTarget(surface);
    void renderer.prewarm().catch((error) => {
      console.error('triangle-led-front prewarm failed', error);
    });
  });

  const leave = () => {
    brush = brushState(DEFAULT_BRUSH);
  };

  const pointerStateForEvent = (event: PointerEvent) => {
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(1, rect.width);
    const height = Math.max(1, rect.height);
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;

    if (x < 0 || x > width || y < 0 || y > height) return null;

    const inside = isPointInsideTriangle({ x, y }, { width, height });
    return {
      x,
      y,
      active: true,
      inside,
      isMouse: event.pointerType === 'mouse',
      cssHeight: height,
    };
  };

  const updatePointer = (event: PointerEvent) => {
    const pointer = pointerStateForEvent(event);
    if (!pointer) {
      leave();
      return false;
    }

    brush = simulationBrushState(
      DEFAULT_BRUSH,
      {
        x: pointer.x,
        y: pointer.y,
        active: pointer.active,
        inside: pointer.inside,
        isMouse: pointer.isMouse,
      },
      pointer.cssHeight,
    );
    return true;
  };

  const isInteractiveEvent = (event: PointerEvent) => {
    const target = event.target;
    return target instanceof Element && target.closest(INTERACTIVE_SELECTOR) !== null;
  };

  document.addEventListener('pointermove', updatePointer, {
    signal: controller.signal,
    passive: true,
  });
  document.addEventListener('pointerup', (event) => {
    if (isInteractiveEvent(event)) return;
    if (!updatePointer(event)) return;
    rgbDeployActive = !rgbDeployActive;
  }, { signal: controller.signal, passive: true });
  window.addEventListener('blur', leave, { signal: controller.signal });
  document.addEventListener('pointerleave', leave, { signal: controller.signal });
  select.addEventListener('change', () => {
    renderer.setHero(heroStateForActiveClick(Number(select.value)));
  }, { signal: controller.signal });

  const handle = gpu.frame.loop((frame) => {
    renderer.setBrush(brush);
    renderer.setRgbDeployActive(rgbDeployActive);
    renderer.renderFrame(frame, { time: gpu.time, dt: gpu.deltaTime });
  });

  return () => {
    if (disposed) return;
    disposed = true;
    handle.stop();
    controller.abort();
    unsubscribeResize();
    selectHost.remove();
    renderer.destroy();
    surface.dispose();
    gpu.dispose();
  };
}

export async function renderThumb(
  gpu: Gpu,
  target: Target,
  opts: ThumbOptions = {},
): Promise<void> {
  const renderer = createHeroRenderer(gpu, {
    theme: 'dark',
    css: { width: target.size[0], height: target.size[1], dpr: 1 },
  });
  renderer.setOutputTarget(target);
  renderer.setHero(heroStateForActiveClick(-1));
  renderer.setRgbDeployActive(false);
  renderer.setBrush(brushState(DEFAULT_BRUSH));
  await renderer.prewarm();

  const warmupFrames = opts.warmupFrames ?? 90;
  const dt = opts.dt ?? 1 / 60;
  let time = opts.time ?? 0;
  for (let i = 0; i < warmupFrames; i++) {
    time += dt;
    gpu.frame((frame) => renderer.renderFrame(frame, { time, dt }));
  }
  await gpu.settled();
}

function cssSizeOf(canvas: HTMLCanvasElement, dpr: Surface['dpr']): CssSize {
  const rect = canvas.getBoundingClientRect();
  return {
    width: Math.max(1, rect.width || canvas.clientWidth || canvas.width / dpr),
    height: Math.max(1, rect.height || canvas.clientHeight || canvas.height / dpr),
    dpr,
  };
}

function createModeSelect(): HTMLSelectElement {
  const select = document.createElement('select');
  select.setAttribute('aria-label', 'Triangle LED mode');
  select.value = '-1';

  const options: Array<[string, string, string]> = [
    ['-1', 'default', 'Default'],
    ['0', 'edge-1', 'Edge 1'],
    ['1', 'edge-2', 'Edge 2'],
    ['2', 'edge-3', 'Edge 3'],
  ];
  for (const [value, key, label] of options) {
    const option = document.createElement('option');
    option.value = value;
    option.dataset.key = key;
    option.textContent = label;
    select.append(option);
  }

  Object.assign(select.style, {
    appearance: 'auto',
    border: '1px solid rgba(255, 255, 255, 0.22)',
    borderRadius: '999px',
    background: 'rgba(0, 0, 0, 0.58)',
    color: 'white',
    font: '500 12px/1 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    padding: '8px 28px 8px 12px',
  });

  return select;
}

function installSelect(canvas: HTMLCanvasElement, select: HTMLSelectElement): HTMLElement {
  const host = document.createElement('div');
  host.append(select);
  Object.assign(host.style, {
    position: 'absolute',
    top: '16px',
    right: '16px',
    zIndex: '2',
    pointerEvents: 'auto',
  });

  const parent = canvas.parentElement;
  if (parent) {
    const position = getComputedStyle(parent).position;
    if (position === 'static') parent.style.position = 'relative';
    parent.append(host);
  } else {
    document.body.append(host);
  }

  return host;
}
