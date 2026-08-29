import { clock, frameLoop, init, surface } from "vgpu";

import { createScene, renderScene } from "./scene";

export async function createRenderer(canvas: HTMLCanvasElement) {
  const gpu = await init();
  try {
    const output = surface(gpu, canvas, { dpr: [1, 2] });
    const scene = createScene(gpu);
    const time = clock(gpu);

    // The loop is registered with the gpu, and every target, geometry and
    // surface above is owned by it, so `gpu.dispose()` is the whole teardown.
    frameLoop(gpu, (currentFrame) =>
      renderScene(currentFrame, scene, output, time.time)
    );

    return { dispose: () => gpu.dispose() };
  } catch (error) {
    gpu.dispose();
    throw error;
  }
}
