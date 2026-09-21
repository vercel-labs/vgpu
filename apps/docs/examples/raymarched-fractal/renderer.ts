import { frame, surface } from "vgpu";
import type { Gpu, Surface } from "vgpu";

import { createRenderScheduler, installDragOrbit } from "./pointer-input";
import { runAll } from "./lifecycle";
import {
  compileScene,
  createScene,
  POSTER,
  renderScene,
  replaceTargets,
  type FractalScene,
  type Orbit,
} from "./pipeline";

interface RendererOptions {
  readonly canvas: HTMLCanvasElement;
}

export function createRenderer({ canvas }: RendererOptions) {
  let disposed = false;
  let failed = false;
  let gpu: Gpu | undefined;
  let output: Surface | undefined;
  let scene: FractalScene | undefined;
  let scheduler: ReturnType<typeof createRenderScheduler> | undefined;
  let disposeInput: (() => void) | undefined;
  let observer: ResizeObserver | undefined;
  let lastDpr = typeof window === "undefined" ? 1 : window.devicePixelRatio;
  const orbit: Orbit = { ...POSTER };

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    runAll([
      () => scheduler?.dispose(),
      () => observer?.disconnect(),
      () => {
        if (typeof window !== "undefined") {
          window.removeEventListener("resize", onWindowResize);
        }
      },
      () => disposeInput?.(),
      () => gpu?.dispose(),
    ]);
  }

  function fail(error: unknown): never {
    failed = true;
    try {
      dispose();
    } catch {
      // Teardown must not replace the live failure.
    }
    throw error;
  }

  function guard<T>(action: () => T): T {
    try {
      return action();
    } catch (error) {
      return fail(error);
    }
  }

  const requestRender = () => guard(() => scheduler?.request());

  const renderOnce = () => {
    if (disposed || !gpu || !output || !scene) return;
    const currentGpu = gpu;
    const currentOutput = output;
    const currentScene = scene;
    guard(() =>
      frame(currentGpu, (currentFrame) => {
        const renderedSize = currentScene.targets.scene.size;
        const outputSize = currentOutput.size;
        if (
          renderedSize[0] !== outputSize[0] ||
          renderedSize[1] !== outputSize[1]
        ) {
          replaceTargets(currentGpu, currentScene, outputSize);
        }
        renderScene(currentFrame, currentScene, currentOutput, orbit);
      })
    );
  };

  const onWindowResize = () =>
    guard(() => {
      if (window.devicePixelRatio === lastDpr) return;
      lastDpr = window.devicePixelRatio;
      scheduler?.request();
    });

  const initialize = async () => {
    const { init } = await import("vgpu");
    if (disposed) return;
    const nextGpu = await init();
    if (disposed) {
      nextGpu.dispose();
      return;
    }

    gpu = nextGpu;
    output = surface(gpu, canvas, { dpr: [1, 1.6] });
    scene = createScene(gpu, output.size);
    await compileScene(scene, output);
    if (disposed) return;

    scheduler = createRenderScheduler(renderOnce);
    disposeInput = installDragOrbit(canvas, orbit, requestRender, fail);
    observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(requestRender);
    observer?.observe(canvas);
    window.addEventListener("resize", onWindowResize);
    scheduler.request();
  };

  const ready = initialize().catch((error: unknown) => {
    if (disposed && !failed) return;
    return fail(error);
  });

  return { ready, invalidate: requestRender, dispose };
}
