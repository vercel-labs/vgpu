import { clock, frameLoop, surface, type Gpu } from 'vgpu';

import { createCamera, createFocus, lightMatrices, orbitBy, resetView, updateCamera, updateFocus, zoomBy } from './camera';
import { createControls, defaultSettings, type Controls } from './controls';
import { attachInput, type Input, type InputActions } from './input';
import { SHADOW_MAP_SIZE, createPipeline, encode, publish, resizePipeline, setStudio, type StudioView } from './pipeline';
import { clearMarbles, createScene, syncMarbles, syncParts } from './scene';
import { createSimulation } from './simulation';

interface RendererOptions {
  readonly canvas: HTMLCanvasElement;
  /** Hosts the lil-gui panel; defaults to the canvas parent. */
  readonly container?: HTMLElement;
}

/** Touch devices run fewer marbles: cannon-es steps on the main thread. */
const COARSE_POINTER_CAPACITY = 24;
/** The follow camera eases more slowly so hand-offs between marbles do not snap. */
const FOLLOW_TIME_CONSTANT = 0.6;
const MACHINE_TIME_CONSTANT = 0.35;

export function createRenderer({ canvas, container }: RendererOptions) {
  let disposed = false;
  let failed = false;
  let gpu: Gpu | undefined;
  let loop: { stop(): void } | undefined;
  let input: Input | undefined;
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

    const media = (query: string) => (typeof window.matchMedia === 'function' ? window.matchMedia(query) : undefined);
    const motionQuery = media('(prefers-reduced-motion: reduce)');
    const settings = defaultSettings(motionQuery?.matches ?? false);
    const simulation = createSimulation({
      autoRelease: settings.autoRelease,
      capacity: media('(pointer: coarse)')?.matches ? COARSE_POINTER_CAPACITY : undefined,
    });
    const scene = createScene(simulation);
    const output = surface(nextGpu, canvas, { dpr: [1, 2] });
    const camera = createCamera();
    const focus = createFocus();
    const light = { view: new Float32Array(16), viewProjection: new Float32Array(16) };
    const shadowTexel = lightMatrices(light, SHADOW_MAP_SIZE);
    let elapsed = 0;
    const aspect = () => output.size[0] / Math.max(1, output.size[1]);
    const studioView = (): StudioView => ({
      camera: camera.matrices,
      eye: camera.pose.position,
      fov: camera.lens.fov,
      aspect: aspect(),
      light,
      shadowTexel,
      time: elapsed,
    });
    updateCamera(camera, updateFocus(focus, camera.mode, simulation), aspect(), 0);
    const pipeline = await createPipeline(nextGpu, scene, output.size, output.format, studioView());
    if (disposed) return;

    // Once the user sets Auto release by hand, motion preference changes leave it alone.
    let autoReleaseChosen = false;
    const setPaused = (paused: boolean) => {
      settings.paused = paused;
      simulation.paused = paused;
    };
    const actions: InputActions = {
      orbit: (deltaYaw, deltaPitch) => orbitBy(camera, deltaYaw, deltaPitch),
      zoom: (factor) => zoomBy(camera, factor),
      release: () => simulation.release(),
      releaseBatch: () => simulation.releaseBatch(),
      togglePause: () => {
        setPaused(!settings.paused);
        controls?.refresh();
      },
      step: () => {
        if (settings.paused) simulation.stepFrame();
      },
      reset: () => {
        // The world is rebuilt with the current gravity and bounce and replays the same start.
        simulation.reset();
        clearMarbles(scene);
        syncParts(scene, simulation);
        resetView(camera);
      },
      resetView: () => resetView(camera),
    };

    unsubscribeResize = output.onResize(() => guard(() => resizePipeline(pipeline, output.size)));
    input = attachInput(canvas, actions, guard);
    controls = createControls(container ?? canvas.parentElement ?? document.body, settings, {
      release: () => guard(actions.release),
      releaseBatch: () => guard(actions.releaseBatch),
      autoRelease: (enabled) =>
        guard(() => {
          autoReleaseChosen = true;
          simulation.autoRelease = enabled;
        }),
      paused: (paused) => guard(() => setPaused(paused)),
      step: () => guard(actions.step),
      gravity: (scale) => guard(() => simulation.setGravityScale(scale)),
      bounce: (bounce) => guard(() => simulation.setBounce(bounce)),
      camera: (mode) =>
        guard(() => {
          camera.mode = mode;
        }),
      reset: () => guard(actions.reset),
    });
    if (motionQuery) {
      const onMotionChange = (event: MediaQueryListEvent) =>
        guard(() => {
          // Reduced motion stops the stream of new marbles and the travelling camera;
          // releases, steps and orbiting stay available.
          if (!autoReleaseChosen) {
            settings.autoRelease = !event.matches;
            simulation.autoRelease = settings.autoRelease;
          }
          if (event.matches) {
            settings.camera = 'machine';
            camera.mode = 'machine';
          }
          controls?.refresh();
        });
      motionQuery.addEventListener('change', onMotionChange);
      unsubscribeMotion = () => motionQuery.removeEventListener('change', onMotionChange);
    }

    const time = clock(nextGpu);
    let snapCamera = true;
    loop = frameLoop(nextGpu, (currentFrame) =>
      guard(() => {
        const dt = Math.min(time.deltaTime, 0.1);
        elapsed += dt;
        simulation.advance(dt);
        syncMarbles(scene, simulation);
        publish(pipeline);
        updateFocus(focus, camera.mode, simulation);
        const timeConstant = camera.mode === 'follow' ? FOLLOW_TIME_CONSTANT : MACHINE_TIME_CONSTANT;
        updateCamera(camera, focus, aspect(), snapCamera ? 0 : dt, timeConstant);
        snapCamera = false;
        setStudio(pipeline, studioView());
        encode(currentFrame, pipeline, output);
      }),
    );
  };

  const ready = initialize().catch((error: unknown) => {
    if (disposed && !failed) return;
    fail(error);
  });

  return { ready, dispose };
}
