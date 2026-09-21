import GUI from "lil-gui";
import { surface, type Gpu, type Surface } from "vgpu";

import { cameraView } from "./camera";
import { installOrbitInput } from "./pointer-input";
import {
  DEFAULT_CONTROLS,
  aspectOf,
  createScene,
  normalizeControls,
  renderScene,
  replaceTargets,
  type Scene,
  type TransmissionControls,
} from "./scene";

interface RendererOptions {
  readonly canvas: HTMLCanvasElement;
  readonly initialControls?: Readonly<TransmissionControls>;
}

export function createRenderer({ canvas, initialControls }: RendererOptions) {
  let disposed = false;
  const controls = normalizeControls(initialControls ?? DEFAULT_CONTROLS);
  let gpu: Gpu | undefined;
  let output: Surface | undefined;
  let scene: Scene | undefined;
  let input: ReturnType<typeof installOrbitInput> | undefined;
  let gui: GUI | undefined;
  let unsubscribeResize: (() => void) | undefined;
  let animationFrame = 0;
  let previous = 0;
  let sawInitialResize = false;

  const onSurfaceResize = () => {
    if (!sawInitialResize) {
      sawInitialResize = true;
      return;
    }
    if (disposed || !gpu || !output || !scene) return;
    try {
      replaceTargets(gpu, scene, output.size);
    } catch (error) {
      fail(error);
    }
  };

  const tick = (now: number) => {
    animationFrame = 0;
    if (disposed) return;
    if (!document.hidden && gpu && output && scene && input) {
      try {
        input.advance((now - previous) / 1000);
        const currentOutput = output;
        const currentInput = input;
        renderScene(
          gpu,
          scene,
          currentOutput,
          () =>
            cameraView(
              currentInput.yaw,
              currentInput.pitch,
              aspectOf(currentOutput),
              currentInput.radius
            ),
          controls
        );
      } catch (error) {
        fail(error);
      }
    }
    previous = now;
    animationFrame = requestAnimationFrame(tick);
  };

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    const cleanups: (() => void)[] = [];
    if (animationFrame) {
      cleanups.push(() => cancelAnimationFrame(animationFrame));
    }
    if (unsubscribeResize) cleanups.push(unsubscribeResize);
    if (input) cleanups.push(() => input?.dispose());
    if (gui) cleanups.push(() => gui?.destroy());
    if (gpu) cleanups.push(() => gpu?.dispose());
    runCleanups(cleanups);
  }

  function fail(error: unknown): never {
    try {
      dispose();
    } catch {
      // Teardown must not replace the render or resize failure.
    }
    throw error;
  }

  const initialize = async () => {
    const { init } = await import("vgpu");
    if (disposed) return;
    const nextGpu = await init();
    if (disposed) {
      nextGpu.dispose();
      return;
    }

    gpu = nextGpu;
    try {
      output = surface(gpu, canvas, { dpr: [1, 2] });
      const nextScene = await createScene(gpu, output);
      if (disposed) return;
      scene = nextScene;
      input = installOrbitInput(canvas);
      gui = new GUI({
        title: "Transmission",
        container: canvas.parentElement ?? undefined,
        width: 180,
      });
      Object.assign(gui.domElement.style, {
        position: "absolute",
        top: "16px",
        right: "16px",
        zIndex: "10",
      });
      gui.add(controls, "ior", 1, 2.4, 0.01).name("IOR");
      gui.add(controls, "roughness", 0, 1, 0.01).name("Roughness");
      gui.add(controls, "dispersion").name("Chromatic dispersion");
      gui
        .add(controls, "refraction", { Simple: "simple", Double: "double" })
        .name("Refraction");

      unsubscribeResize = output.onResize(onSurfaceResize);
      previous = performance.now();
      animationFrame = requestAnimationFrame(tick);
    } catch (error) {
      if (disposed) return;
      throw error;
    }
  };

  const ready = initialize().catch((error: unknown) => {
    if (disposed) return;
    fail(error);
  });
  return { ready, dispose };
}

function runCleanups(cleanups: readonly (() => void)[]): void {
  let firstError: unknown;
  let failed = false;
  for (const cleanup of cleanups) {
    try {
      cleanup();
    } catch (error) {
      if (!failed) firstError = error;
      failed = true;
    }
  }
  if (failed) throw firstError;
}
