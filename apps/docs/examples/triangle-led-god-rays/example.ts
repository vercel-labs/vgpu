import { init, type Gpu, type Target } from 'vgpu';
import { createRadianceRenderer } from './renderer';
import {
  DEFAULT_BRUSH,
  HERO_STATE_DEFAULTS,
  HERO_STATE_MODES,
  type BrushSettings,
  type HeroStateMode,
} from './settings';

interface BrushState extends BrushSettings {
  x: number;
  y: number;
  active: boolean;
}

export interface TriangleLedGodRaysThumbOptions {
  readonly frames?: number;
  readonly warmupFrames?: number;
  readonly dt?: number;
  readonly time?: number;
}

export async function renderThumb(
  gpu: Gpu,
  target: Target,
  {
    frames,
    warmupFrames = frames ?? 60,
    dt = 1 / 60,
    time = warmupFrames * dt,
  }: TriangleLedGodRaysThumbOptions = {},
): Promise<void> {
  const renderer = createRadianceRenderer(gpu.device, target.format);
  try {
    const [width, height] = target.size;
    await renderer.warmup(width, height);
    for (let i = 0; i < warmupFrames; i++) {
      renderer.render(
        target.color.view,
        width,
        height,
        undefined,
        Math.max(0, time - (warmupFrames - i) * dt),
        undefined,
        undefined,
        undefined,
        { hero: { ...HERO_STATE_DEFAULTS, mode: HERO_STATE_MODES.coding }, theme: 'dark' },
      );
    }
    renderer.render(
      target.color.view,
      width,
      height,
      undefined,
      time,
      undefined,
      undefined,
      undefined,
      { hero: { ...HERO_STATE_DEFAULTS, mode: HERO_STATE_MODES.coding }, theme: 'dark' },
    );
  } finally {
    renderer.destroy();
  }
}

export async function run(canvas: HTMLCanvasElement): Promise<() => void> {
  const gpu = await init();
  const surface = gpu.surface(canvas, { dpr: [1, 2] });
  const renderer = createRadianceRenderer(gpu.device, surface.format);
  const brush = brushState();
  const controls = installControls(canvas, (mode) => {
    heroMode = mode;
  }, () => {
    theme = theme === 'dark' ? 'light' : 'dark';
    controls.theme.textContent = `theme: ${theme}`;
  });
  const removePointer = installPointer(canvas, brush);
  let heroMode: HeroStateMode = HERO_STATE_MODES.coding;
  let theme: 'dark' | 'light' = 'dark';

  let disposed = false;
  let warming = renderer.warmup(surface.size[0], surface.size[1]);
  const removeResize = surface.onResize(({ width, height }) => {
    warming = renderer.warmup(width, height);
  });

  warming.catch((error) => console.error(error));
  const handle = gpu.frame.loop(() => {
    if (disposed) return;
    warming.catch((error) => console.error(error));
    renderer.render(
      surface.color.view,
      surface.size[0],
      surface.size[1],
      brush,
      gpu.time,
      undefined,
      undefined,
      undefined,
      { hero: { ...HERO_STATE_DEFAULTS, mode: heroMode }, theme },
    );
  });

  return () => {
    disposed = true;
    handle.stop();
    removeResize();
    removePointer();
    controls.remove();
    renderer.destroy();
    surface.dispose();
    gpu.dispose();
  };
}

function installControls(
  canvas: HTMLCanvasElement,
  setMode: (mode: HeroStateMode) => void,
  toggleTheme: () => void,
) {
  const host = canvas.parentElement ?? canvas;
  const controls = document.createElement('div');
  controls.style.cssText = [
    'position:absolute',
    'left:16px',
    'top:16px',
    'z-index:10',
    'display:flex',
    'gap:8px',
    'flex-wrap:wrap',
    'font:12px/1.2 system-ui,sans-serif',
  ].join(';');

  const addButton = (label: string, onClick: () => void) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.style.cssText = [
      'border:1px solid rgba(255,255,255,.25)',
      'border-radius:999px',
      'background:rgba(0,0,0,.45)',
      'color:white',
      'padding:6px 10px',
      'cursor:pointer',
      'backdrop-filter:blur(8px)',
    ].join(';');
    button.addEventListener('click', onClick);
    controls.appendChild(button);
    return button;
  };

  addButton('coding', () => setMode(HERO_STATE_MODES.coding));
  addButton('shipping', () => setMode(HERO_STATE_MODES.scan));
  addButton('automating', () => setMode(HERO_STATE_MODES.pulse));
  addButton('scan', () => setMode(HERO_STATE_MODES.scan));
  addButton('pulse', () => setMode(HERO_STATE_MODES.pulse));
  const theme = addButton('theme: dark', toggleTheme);
  host.appendChild(controls);

  return { theme, remove: () => controls.remove() };
}

function installPointer(canvas: HTMLCanvasElement, brush: BrushState) {
  const move = (e: PointerEvent) => {
    const rect = canvas.getBoundingClientRect();
    brush.x = e.clientX - rect.left;
    brush.y = e.clientY - rect.top;
    brush.active = true;
  };
  const leave = () => {
    brush.x = -1000;
    brush.y = -1000;
    brush.active = false;
  };
  canvas.addEventListener('pointermove', move);
  canvas.addEventListener('pointerdown', move);
  canvas.addEventListener('pointerup', leave);
  canvas.addEventListener('pointerleave', leave);
  return () => {
    canvas.removeEventListener('pointermove', move);
    canvas.removeEventListener('pointerdown', move);
    canvas.removeEventListener('pointerup', leave);
    canvas.removeEventListener('pointerleave', leave);
  };
}

function brushState(): BrushState {
  return { ...DEFAULT_BRUSH, x: -1000, y: -1000, active: false };
}
