import { effect, frameLoop, init, surface } from 'vgpu';
import fragment from './shader.wgsl';

export async function createRenderer(canvas: HTMLCanvasElement) {
  const gpu = await init();
  try {
    const output = surface(gpu, canvas, { dpr: [1, 2] });
    const shader = effect(gpu, fragment);
    frameLoop(gpu, (currentFrame) => currentFrame.pass(output, shader));
    return { dispose: () => gpu.dispose() };
  } catch (error) {
    gpu.dispose();
    throw error;
  }
}
