import type { Draw, Frame, Gpu, Geometry, Target } from 'vgpu';
import { disk, icosphere, perspectiveCamera } from 'vgpu/scene';
import { clock, draw, frame, frameLoop, geometry, init, surface } from 'vgpu';
import type { ThumbnailOptions } from '../../lib/example-renderer';
import clippedWgsl from './clipped.wgsl';

interface ClippingScene { geometries: Geometry[]; body: Draw; cap: Draw }

export async function createRenderer(canvas: HTMLCanvasElement) {
  const gpu = await init();
  try {
    const output = surface(gpu, canvas, { dpr: [1, 2] });
    const scene = createScene(gpu);
    const time = clock(gpu);
    frameLoop(gpu, (currentFrame) => render(currentFrame, scene, output, time.time));
    return { dispose: () => gpu.dispose() };
  } catch (error) {
    gpu.dispose();
    throw error;
  }
}

export async function renderThumbnail(gpu: Gpu, output: Target, options: ThumbnailOptions = {}): Promise<void> {
  const scene = createScene(gpu);
  try {
    frame(gpu, (currentFrame) => render(currentFrame, scene, output, options.time ?? 2.4));
  } finally {
    await Promise.allSettled([
      Promise.resolve().then(() => gpu.gpu.queue.onSubmittedWorkDone()),
      Promise.resolve().then(() => gpu.settled()),
    ]);
    scene.geometries.forEach((item) => item.destroy());
  }
}

function createScene(gpu: Gpu): ClippingScene {
  const geometries = [
    geometry(gpu, icosphere({ radius: 1, subdivisions: 4, shading: 'flat' })),
    geometry(gpu, disk({ radius: 1, segments: 64 })),
  ];
  const body = draw(gpu, { shader: clippedWgsl, geometry: geometries[0], cull: 'back' });
  const cap = draw(gpu, { shader: clippedWgsl, geometry: geometries[1], cull: 'back' });
  return { geometries, body, cap };
}

function render(currentFrame: Frame, scene: ClippingScene, output: Target, time: number): void {
  const camera = perspectiveCamera({
    fov: 36,
    aspect: output.size[0] / Math.max(1, output.size[1]),
    near: 0.1,
    far: 20,
    position: [0, 0, 4.2],
    target: [0, 0, 0],
  });
  const clip = 0.08 + Math.sin(time * 0.72) * 0.46;
  const uniforms = { view_projection: camera.viewProjection, time, clip };
  scene.body.set({ scene: { ...uniforms, cap: 0 } });
  scene.cap.set({ scene: { ...uniforms, cap: 1 } });
  currentFrame.pass(output, (pass) => {
    pass.draw(scene.body);
    pass.draw(scene.cap);
  });
}
