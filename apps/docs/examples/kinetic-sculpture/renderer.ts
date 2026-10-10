import { clock, frameLoop, surface, type Gpu } from 'vgpu';

import { createCamera, lightMatrices, orbitBy, resetView, zoomBy } from './camera';
import { applyMotionPreference, createControls, defaultSettings, type Controls } from './controls';
import { installOrbitInput, type OrbitInput } from './input';
import { createPipeline, renderSculpture, resizePipeline } from './pipeline';
import { buildMobile, createCollections, poseMobile, rebuildMobile, type Mobile } from './scene';

interface RendererOptions {
  readonly canvas: HTMLCanvasElement;
  /** Hosts the lil-gui panel; defaults to the canvas parent. */
  readonly container?: HTMLElement;
}

const DEG = Math.PI / 180;

export function createRenderer({ canvas, container }: RendererOptions) {
  let disposed = false;
  let failed = false;
  let gpu: Gpu | undefined;
  let loop: { stop(): void } | undefined;
  let input: OrbitInput | undefined;
  let controls: Controls | undefined;
  let unsubscribeResize: (() => void) | undefined;
  let unsubscribeMotion: (() => void) | undefined;

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    const cleanups = [
      () => loop?.stop(),
      () => unsubscribeResize?.(),
      () => unsubscribeMotion?.(),
      () => input?.dispose(),
      () => controls?.destroy(),
      // Releases the pipeline's targets, draws and instance buffers with it.
      () => gpu?.dispose(),
    ];
    let firstError: unknown;
    for (const cleanup of cleanups) {
      try {
        cleanup();
      } catch (error) {
        firstError ??= error;
      }
    }
    if (firstError !== undefined) throw firstError;
  }

  function fail(error: unknown): never {
    failed = true;
    try {
      dispose();
    } catch {}
    throw error;
  }

  /** Runs event and frame work; the first throw disposes everything and surfaces once. */
  function guard(action: () => void): void {
    if (disposed) return;
    try {
      action();
    } catch (error) {
      try {
        fail(error);
      } catch (surfaced) {
        queueMicrotask(() => {
          throw surfaced;
        });
      }
    }
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

    const motionQuery =
      typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)') : undefined;
    const settings = defaultSettings(motionQuery?.matches ?? false);
    const output = surface(nextGpu, canvas, { dpr: [1, 2] });
    const collections = createCollections();
    let mobile: Mobile = buildMobile(collections, settings.levels);
    const pipeline = await createPipeline(nextGpu, collections, output.size, output.format);
    if (disposed) return;

    const camera = createCamera();
    const light = { view: new Float32Array(16), viewProjection: new Float32Array(16) };
    const fitLight = () => lightMatrices(mobile.center, mobile.radius, light);
    fitLight();
    let animationTime = 0;
    let snapCamera = true;

    unsubscribeResize = output.onResize(() => guard(() => resizePipeline(pipeline, output.size)));
    input = installOrbitInput(
      canvas,
      {
        orbit: (deltaYaw, deltaPitch) => orbitBy(camera, deltaYaw, deltaPitch),
        zoom: (factor) => zoomBy(camera, factor),
      },
      guard,
    );
    controls = createControls(container ?? canvas.parentElement ?? document.body, settings, {
      levels: (levels) =>
        guard(() => {
          if (levels === mobile.levels) return;
          mobile = rebuildMobile(collections, mobile, levels);
          fitLight();
        }),
      // Reset keeps the play state: a paused mobile returns to its start pose and stays still.
      reset: () =>
        guard(() => {
          animationTime = 0;
          settings.rootAngle = 0;
          resetView(camera);
          controls?.refresh();
        }),
    });
    if (motionQuery) {
      const onMotionChange = (event: MediaQueryListEvent) =>
        guard(() => {
          applyMotionPreference(settings, event.matches);
          controls?.refresh();
        });
      motionQuery.addEventListener('change', onMotionChange);
      unsubscribeMotion = () => motionQuery.removeEventListener('change', onMotionChange);
    }

    const time = clock(nextGpu);
    loop = frameLoop(nextGpu, (currentFrame) =>
      guard(() => {
        const dt = Math.min(time.deltaTime, 0.1);
        if (settings.playing) animationTime += dt * settings.speed;
        poseMobile(mobile, { time: animationTime, swing: settings.swing, rootAngle: settings.rootAngle * DEG });
        renderSculpture(currentFrame, pipeline, collections, { mobile, camera, light }, output, snapCamera ? 0 : dt);
        snapCamera = false;
      }),
    );
  };

  const ready = initialize().catch((error: unknown) => {
    if (disposed && !failed) return;
    fail(error);
  });

  return { ready, dispose };
}
