import { clock, frameLoop, init, surface, type Gpu } from "vgpu";

import { createScene, renderScene } from "./scene";

export function createRenderer(canvas: HTMLCanvasElement) {
  let disposed = false;
  let failed = false;
  let gpu: Gpu | undefined;
  let loop: { stop(): void } | undefined;

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    const failures: unknown[] = [];
    for (const cleanup of [() => loop?.stop(), () => gpu?.dispose()]) {
      try {
        cleanup();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length) throw failures[0];
  };

  const fail = (error: unknown): never => {
    failed = true;
    try {
      dispose();
    } catch {
      // Teardown must not replace the live or initialization failure.
    }
    throw error;
  };

  const initialize = async () => {
    if (disposed) return;
    const nextGpu = await init();
    gpu = nextGpu;
    if (disposed) {
      try {
        nextGpu.dispose();
      } catch {
        // Intentional stale cleanup is quiet.
      }
      return;
    }

    const output = surface(nextGpu, canvas, { dpr: [1, 2] });
    const scene = await createScene(nextGpu);
    if (disposed) return;

    const time = clock(nextGpu);
    loop = frameLoop(nextGpu, (currentFrame) => {
      if (disposed) return;
      try {
        renderScene(currentFrame, scene, output, time.time);
      } catch (error) {
        fail(error);
      }
    });
  };

  const ready = initialize().catch((error: unknown) => {
    if (disposed && !failed) return;
    fail(error);
  });

  return { ready, dispose };
}
