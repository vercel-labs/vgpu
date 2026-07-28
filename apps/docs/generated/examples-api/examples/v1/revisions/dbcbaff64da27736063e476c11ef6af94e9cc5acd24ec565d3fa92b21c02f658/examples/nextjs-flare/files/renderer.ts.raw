import type { Gpu, Surface, Target } from 'vgpu';

import type {
  BrowserRendererOptions,
  ExampleRenderer,
  RenderSize,
  ThumbnailOptions,
} from '../../lib/example-renderer';
import { followLight, mapAutonomousLight, type Point } from './animation';
import {
  BAKED_LOGO_HEIGHT,
  BAKED_LOGO_WIDTH,
  bakedLogoRgba,
} from './logo-raster-baked';
import { rasterizeLogo } from './logo-raster';
import { FlarePipeline } from './pipeline';
import {
  backingDimensions,
  DEFAULT_FLARE_SETTINGS,
  flarePlacement,
  type FlarePlacement,
} from './settings';
import {
  createLogoTexture,
  uploadLogoTexture,
  uploadLogoTextureRgba,
} from './textures';

// The marketing hero renders at 30fps; the flare's temporal blue-noise jitter
// is tuned for that cadence.
const FRAME_INTERVAL_MS = 33;
// Hovering pins the breathing fully on; the ~0.35s ease ramps the intensity
// up from an off-phase hover instead of popping.
const PULSE_HOLD_SECONDS = 0.35;
const LOGO_CENTER: Point = [0.5, 0.5];

export function createRenderer(options: BrowserRendererOptions): ExampleRenderer {
  const settings = DEFAULT_FLARE_SETTINGS;
  let disposed = false;
  let gpu: Gpu | undefined;
  let surface: Surface | undefined;
  let pipeline: FlarePipeline | undefined;
  let logoTexture: GPUTexture | undefined;
  let placement: FlarePlacement | undefined;
  let light: Point = LOGO_CENTER;
  let pointer: Point | undefined;
  let pulseHold = 0;
  let frameIndex = 0;
  let staticDirty = true;
  let lastTime = 0;
  let lastRender = -Infinity;
  let rafId = 0;
  let observer: ResizeObserver | undefined;
  let pendingSize: RenderSize | undefined;
  let applyingResize = false;
  let appliedBacking: readonly [number, number] = [0, 0];
  let reportedError = false;

  const uploadLogo = (source: HTMLCanvasElement) => {
    if (!gpu || !pipeline || !placement) return;
    logoTexture?.destroy();
    logoTexture = createLogoTexture(gpu, source.width, source.height);
    uploadLogoTexture(gpu, logoTexture, source, source.width, source.height);
    pipeline.bindLogoTexture(logoTexture, source.width, source.height, placement);
    staticDirty = true;
  };

  const applySize = async (size: RenderSize) => {
    if (!pipeline) return;
    const backing = backingDimensions(size.width, size.height, size.dpr);
    if (backing[0] === appliedBacking[0] && backing[1] === appliedBacking[1]) return;
    appliedBacking = backing;
    await pipeline.resize(backing);
    if (disposed) return;
    // The reference size is the virtual square the glyph box is measured
    // against; rasterizing at backing resolution keeps the strokes crisp.
    const reference = Math.min(backing[0], backing[1]);
    placement = flarePlacement(backing[0], backing[1], reference, LOGO_CENTER);
    const logo = await rasterizeLogo(reference, 1);
    if (disposed) return;
    uploadLogo(logo);
  };

  const drainResizes = async () => {
    if (applyingResize) return;
    applyingResize = true;
    try {
      while (pendingSize && !disposed) {
        const size = pendingSize;
        pendingSize = undefined;
        await applySize(size);
      }
    } catch (error) {
      handleFailure(error);
    } finally {
      applyingResize = false;
    }
  };

  const resize = (size: RenderSize) => {
    if (disposed || size.width <= 0 || size.height <= 0) return;
    pendingSize = size;
    void drainResizes();
  };

  const measure = () => {
    const rect = options.canvas.getBoundingClientRect();
    resize({
      width: rect.width,
      height: rect.height,
      dpr: window.devicePixelRatio || 1,
    });
  };

  const handlePointerMove = (event: PointerEvent) => {
    // Touch must never steer the light: coarse inputs keep the autonomous
    // animation, exactly like the marketing hero.
    if (event.pointerType === 'touch') return;
    const rect = options.canvas.getBoundingClientRect();
    pointer = [
      Math.min(1, Math.max(0, (event.clientX - rect.left) / Math.max(1, rect.width))),
      Math.min(1, Math.max(0, (event.clientY - rect.top) / Math.max(1, rect.height))),
    ];
  };
  const handlePointerLeave = () => {
    pointer = undefined;
  };

  const frameLoop = (now: number) => {
    if (disposed) return;
    rafId = requestAnimationFrame(frameLoop);
    if (now - lastRender < FRAME_INTERVAL_MS) return;
    if (!pipeline?.ready || !logoTexture || !placement) return;
    lastRender = now;
    const time = now / 1000;
    const dt = Math.min(Math.max(time - lastTime, 0), 0.05);
    lastTime = time;
    const target = pointer ?? mapAutonomousLight(time, placement);
    light = followLight(light, target, dt, settings.followSeconds);
    pulseHold +=
      ((pointer ? 1 : 0) - pulseHold) * (1 - Math.exp(-dt / PULSE_HOLD_SECONDS));
    pipeline.setFrameUniforms(settings, placement, light, frameIndex, time, pulseHold);
    pipeline.draw(staticDirty);
    staticDirty = false;
    frameIndex += 1;
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
    pendingSize = undefined;
    observer?.disconnect();
    observer = undefined;
    options.canvas.removeEventListener('pointermove', handlePointerMove);
    options.canvas.removeEventListener('pointerleave', handlePointerLeave);
    options.canvas.removeEventListener('pointercancel', handlePointerLeave);
    logoTexture?.destroy();
    logoTexture = undefined;
    pipeline?.dispose();
    pipeline = undefined;
    surface?.dispose();
    surface = undefined;
    gpu?.dispose();
    gpu = undefined;
  };

  const initialize = async () => {
    const { init } = await import('vgpu');
    if (disposed) return;
    const nextGpu = await init({ label: 'nextjs-flare-example' });
    if (disposed) {
      nextGpu.dispose();
      return;
    }
    gpu = nextGpu;
    surface = gpu.surface(options.canvas, {
      autoResize: false,
      alphaMode: 'opaque',
      format: 'bgra8unorm',
    });
    pipeline = new FlarePipeline(gpu, surface);
    const rect = options.canvas.getBoundingClientRect();
    await applySize({
      width: Math.max(1, rect.width),
      height: Math.max(1, rect.height),
      dpr: window.devicePixelRatio || 1,
    });
    if (disposed) return;
    light = placement?.logoCenter ?? LOGO_CENTER;
    options.canvas.addEventListener('pointermove', handlePointerMove);
    options.canvas.addEventListener('pointerleave', handlePointerLeave);
    options.canvas.addEventListener('pointercancel', handlePointerLeave);
    observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure);
    observer?.observe(options.canvas);
    rafId = requestAnimationFrame(frameLoop);
  };

  function handleFailure(error: unknown): void {
    if (disposed) return;
    if (!reportedError) {
      reportedError = true;
      try {
        options.onError?.(error);
      } catch {
        // Error reporting must not block teardown.
      }
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

// Deterministic headless frame for the docs thumbnails: the hero preview
// framing with the N at two thirds, captured mid-orbit with the light pulse
// fully on. The glyph raster ships pre-baked because there is no DOM here.
export async function renderThumbnail(
  gpu: Gpu,
  target: Target,
  opts: ThumbnailOptions = {},
): Promise<void> {
  const pipeline = new FlarePipeline(gpu, target);
  let logoTexture: GPUTexture | undefined;
  try {
    await pipeline.resize(target.size);
    const [width, height] = target.size;
    const placement = flarePlacement(width, height, height, [2 / 3, 0.5]);
    const rgba = await bakedLogoRgba();
    logoTexture = createLogoTexture(gpu, BAKED_LOGO_WIDTH, BAKED_LOGO_HEIGHT);
    uploadLogoTextureRgba(gpu, logoTexture, rgba, BAKED_LOGO_WIDTH, BAKED_LOGO_HEIGHT);
    pipeline.bindLogoTexture(logoTexture, BAKED_LOGO_WIDTH, BAKED_LOGO_HEIGHT, placement);
    const time = opts.time ?? 4.2;
    const light = mapAutonomousLight(time, placement);
    pipeline.setFrameUniforms(DEFAULT_FLARE_SETTINGS, placement, light, 0, time, 0);
    pipeline.draw(true);
    await gpu.gpu.queue.onSubmittedWorkDone();
  } finally {
    await Promise.allSettled([gpu.settled()]);
    logoTexture?.destroy();
    pipeline.dispose();
  }
}
