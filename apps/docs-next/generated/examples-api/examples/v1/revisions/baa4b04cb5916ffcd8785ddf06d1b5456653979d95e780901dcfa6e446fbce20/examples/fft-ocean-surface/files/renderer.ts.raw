import type { Gpu, Surface, Target } from 'vgpu';
import type { BrowserRendererOptions, ExampleRenderer, RenderSize, ThumbnailOptions } from '../../lib/example-renderer';
import { clock, compute, draw, effect, frame, frameLoop, geometry, sampler, storage, surface, target } from 'vgpu';
import { orbitControls, perspectiveCamera } from 'vgpu/scene';
import GUI from 'lil-gui';
import { buildOcean, type OceanApi, type OceanScene, type OceanShaders } from './scene';
import spectrumInit from './spectrum-init.wgsl';
import spectrumUpdate from './spectrum-update.wgsl';
import fftRow from './fft-row.wgsl';
import fftCol from './fft-col.wgsl';
import bake from './bake.wgsl';
import oceanSurface from './ocean-surface.wgsl';
import skydomeShader from './skydome.wgsl';
import compositeShader from './composite.wgsl';

const api: OceanApi = { compute, storage, draw, geometry, effect, target, sampler };
const shaders: OceanShaders = {
  spectrumInit,
  spectrumUpdate,
  fftRow,
  fftCol,
  bake,
  oceanSurface,
  skydome: skydomeShader,
  composite: compositeShader,
};

const CAMERA = { fov: 48, near: 1, far: 8000, position: [0, 24, 128] as const, target: [0, 5, 0] as const };

export function createRenderer(options: BrowserRendererOptions): ExampleRenderer {
  let disposed = false;
  let gpu: Gpu | undefined;
  let canvasSurface: Surface | undefined;
  let scene: OceanScene | undefined;
  let camera: ReturnType<typeof perspectiveCamera> | undefined;
  let controls: ReturnType<typeof orbitControls> | undefined;
  let gui: GUI | undefined;
  let loop: { stop(): void } | undefined;
  let observer: ResizeObserver | undefined;
  let resizeFrame = 0;
  let pendingSize: RenderSize | undefined;
  let lastDpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio;
  let reportedError = false;
  const view = { autoRotate: false, rotateSpeed: 0.12 };

  const applyResize = () => {
    resizeFrame = 0;
    const size = pendingSize;
    pendingSize = undefined;
    if (disposed || !size || !canvasSurface || !scene || !camera) return;
    try {
      const px: [number, number] = [
        Math.max(1, Math.round(size.width * size.dpr)),
        Math.max(1, Math.round(size.height * size.dpr)),
      ];
      canvasSurface.resize(px);
      scene.resize(px);
      camera.set({ aspect: px[0] / px[1] });
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
    controls?.dispose();
    controls = undefined;
    gui?.destroy();
    gui = undefined;
    canvasSurface?.dispose();
    canvasSurface = undefined;
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
    canvasSurface = surface(gpu, options.canvas, { dpr: [1, 2] });
    scene = buildOcean(gpu, api, shaders, { size: canvasSurface.size });

    camera = perspectiveCamera({
      fov: CAMERA.fov,
      aspect: canvasSurface.size[0] / canvasSurface.size[1],
      near: CAMERA.near,
      far: CAMERA.far,
      position: CAMERA.position,
      target: CAMERA.target,
    });
    controls = orbitControls(camera, {
      element: options.canvas,
      target: CAMERA.target,
      damping: 0.12,
      distance: { min: 20, max: 700 },
      pitch: { min: -0.05, max: 1.35 },
    });
    gui = buildGui(scene, view, options.canvas.parentElement);

    observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure);
    observer?.observe(options.canvas);
    window.addEventListener('resize', onWindowResize);
    measure();

    const gpuClock = clock(gpu);
    loop = frameLoop(gpu, (currentFrame) => {
      if (disposed || !canvasSurface || !scene || !camera || !controls) return;
      const dt = gpuClock.deltaTime;
      controls.update(dt);
      if (view.autoRotate) controls.set({ yaw: controls.yaw + dt * view.rotateSpeed });
      scene.simulate(dt);
      scene.updateCamera(camera.viewProjection, camera.worldPosition);
      currentFrame.pass({ target: scene.hdr, clear: scene.clear }, (pass) => {
        pass.draw(scene!.skydome);
        pass.draw(scene!.ocean);
      });
      currentFrame.pass(canvasSurface, scene.composite);
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

function buildGui(scene: OceanScene, view: { autoRotate: boolean; rotateSpeed: number }, container: HTMLElement | null): GUI {
  const gui = new GUI({ title: 'Ocean', container: container ?? undefined });
  // With a container, lil-gui drops its fixed auto-placement, so pin it as an
  // overlay in the example's top-right corner and let it scroll if cramped.
  Object.assign(gui.domElement.style, {
    position: 'absolute',
    top: '8px',
    right: '8px',
    zIndex: '10',
    maxHeight: 'calc(100% - 16px)',
    overflowY: 'auto',
  });
  const p = scene.params;
  const rebuild = () => scene.rebuildSpectrum();

  const waves = gui.addFolder('Waves');
  waves.add(p, 'windSpeed', 2, 60, 0.5).name('wind speed').onChange(rebuild);
  waves.add(p, 'windAngle', 0, 360, 1).name('wind angle').onChange(rebuild);
  waves.add(p, 'amplitude', 0.2, 16, 0.1).onChange(rebuild);
  waves.add(p, 'patchSize', 60, 600, 1).name('patch size (m)').onChange(rebuild);

  const look = gui.addFolder('Look');
  look.add(p, 'heightScale', 0, 80, 0.5).name('height');
  look.add(p, 'choppyScale', 0, 40, 0.5).name('choppiness');
  look.add(p, 'foamScale', 0.05, 1.2, 0.01).name('foam');

  const sun = gui.addFolder('Sun');
  sun.add(p, 'sunElevation', -2, 60, 0.5).name('elevation');
  sun.add(p, 'sunAzimuth', 0, 360, 1).name('azimuth');

  const sim = gui.addFolder('Sim');
  sim.add(p, 'timeScale', 0, 3, 0.05).name('speed');
  sim.add(view, 'autoRotate').name('auto-rotate');
  sim.add(view, 'rotateSpeed', 0.02, 0.6, 0.01).name('rotate speed');

  return gui;
}

export async function renderThumbnail(gpu: Gpu, output: Target, opts: ThumbnailOptions = {}): Promise<void> {
  try {
    const scene = buildOcean(gpu, api, shaders, { size: output.size });
    const camera = perspectiveCamera({
      fov: CAMERA.fov,
      aspect: output.size[0] / output.size[1],
      near: CAMERA.near,
      far: CAMERA.far,
      position: CAMERA.position,
      target: CAMERA.target,
    });

    // Advance the simulation to a settled, wave-rich moment, then draw one frame.
    const dt = opts.dt ?? 1 / 60;
    const warmup = Math.max(0, opts.warmupFrames ?? 0);
    for (let i = 0; i < warmup; i++) scene.simulate(dt);
    scene.simulate((opts.time ?? 9) - warmup * dt);
    scene.updateCamera(camera.viewProjection, camera.worldPosition);

    frame(gpu, (currentFrame) => {
      currentFrame.pass({ target: scene.hdr, clear: scene.clear }, (pass) => {
        pass.draw(scene.skydome);
        pass.draw(scene.ocean);
      });
      currentFrame.pass(output, scene.composite);
    });
  } finally {
    await Promise.allSettled([
      Promise.resolve().then(() => gpu.gpu.queue.onSubmittedWorkDone()),
      Promise.resolve().then(() => gpu.settled()),
    ]);
  }
}
