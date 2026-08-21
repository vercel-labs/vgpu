import type { Draw, Frame, Gpu, Geometry, Surface, Target } from 'vgpu';
import { disk, icosphere, perspectiveCamera } from 'vgpu/scene';
import { clock, draw, frame, frameLoop, geometry, surface } from 'vgpu';
import type { BrowserRendererOptions, ExampleRenderer, RenderSize, ThumbnailOptions } from '../../lib/example-renderer';
import clippedWgsl from './clipped.wgsl';

type Output = Surface | Target;
interface ClippingScene { geometries: Geometry[]; body: Draw; cap: Draw }

export function createRenderer(options: BrowserRendererOptions): ExampleRenderer {
  let disposed = false;
  let gpu: Gpu | undefined;
  let output: Surface | undefined;
  let scene: ClippingScene | undefined;
  let loop: { stop(): void } | undefined;
  let observer: ResizeObserver | undefined;
  let resizeFrame = 0;
  let pendingSize: RenderSize | undefined;
  let reportedError = false;

  const fail = (error: unknown) => {
    try {
      if (!reportedError) { reportedError = true; options.onError?.(error); }
    } finally { dispose(); }
  };
  const applyResize = () => {
    resizeFrame = 0;
    const size = pendingSize;
    pendingSize = undefined;
    if (!size || !output || !scene || disposed) return;
    try {
      output.resize([Math.max(1, Math.round(size.width * size.dpr)), Math.max(1, Math.round(size.height * size.dpr))]);
    } catch (error) { fail(error); }
  };
  const resize = (size: RenderSize) => {
    if (disposed || size.width <= 0 || size.height <= 0) return;
    pendingSize = size;
    if (!resizeFrame) resizeFrame = requestAnimationFrame(applyResize);
  };
  const measure = () => {
    const rect = options.canvas.getBoundingClientRect();
    resize({ width: rect.width, height: rect.height, dpr: Math.min(2, window.devicePixelRatio || 1) });
  };
  function dispose() {
    if (disposed) return;
    disposed = true;
    loop?.stop();
    if (resizeFrame) cancelAnimationFrame(resizeFrame);
    observer?.disconnect();
    scene?.geometries.forEach((item) => item.destroy());
    output?.dispose();
    gpu?.dispose();
  }

  const ready = (async () => {
    const { init } = await import('vgpu');
    const nextGpu = await init();
    if (disposed) { nextGpu.dispose(); return; }
    gpu = nextGpu;
    output = surface(gpu, options.canvas, { dpr: [1, 2] });
    scene = await createScene(gpu, output);
    if (disposed) return;
    observer = new ResizeObserver(measure);
    observer.observe(options.canvas);
    measure();
    const time = clock(gpu);
    loop = frameLoop(gpu, (currentFrame) => {
      if (scene && output) render(currentFrame, scene, output, time.time);
    });
  })().catch((error: unknown) => { if (!disposed) fail(error); throw error; });

  return { ready, invalidate() {}, resize, dispose };
}

export async function renderThumbnail(gpu: Gpu, output: Target, options: ThumbnailOptions = {}): Promise<void> {
  const scene = await createScene(gpu, output);
  try {
    frame(gpu, (currentFrame) => render(currentFrame, scene, output, options.time ?? 2.4));
  } finally {
    await Promise.allSettled([gpu.gpu.queue.onSubmittedWorkDone(), gpu.settled()]);
    scene.geometries.forEach((item) => item.destroy());
  }
}

async function createScene(gpu: Gpu, output: Output): Promise<ClippingScene> {
  const geometries = [
    geometry(gpu, icosphere({ radius: 1, subdivisions: 4, shading: 'flat' })),
    geometry(gpu, disk({ radius: 1, segments: 64 })),
  ];
  const body = draw(gpu, { shader: clippedWgsl, geometry: geometries[0], cull: 'back', label: 'clipped-body' });
  const cap = draw(gpu, { shader: clippedWgsl, geometry: geometries[1], cull: 'back', label: 'clipped-cap' });
  await body.compile({ colors: [output.format] });
  await cap.compile({ colors: [output.format] });
  return { geometries, body, cap };
}

function render(currentFrame: Frame, scene: ClippingScene, output: Output, time: number): void {
  const camera = perspectiveCamera({
    fov: 36,
    aspect: output.size[0] / Math.max(1, output.size[1]),
    near: 0.1,
    far: 20,
    position: [0, 0, 4.2],
    target: [0, 0, 0],
  });
  const clip = 0.08 + Math.sin(time * 0.72) * 0.46;
  scene.body.set({ scene: { view_projection: camera.viewProjection, time, clip, cap: 0, _pad: 0 } });
  scene.cap.set({ scene: { view_projection: camera.viewProjection, time, clip, cap: 1, _pad: 0 } });
  currentFrame.pass({ target: output, clear: [0, 0, 0, 1] }, (pass) => {
    pass.draw(scene.body);
    pass.draw(scene.cap);
  });
}
