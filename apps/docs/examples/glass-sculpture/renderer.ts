import GUI from "lil-gui";
import { surface, type Gpu, type Surface } from "vgpu";

import { cameraView } from "./camera";
import { installPointerInput } from "./pointer-input";
import {
  DEFAULT_CONTROLS,
  createScene,
  normalizeControls,
  renderScene,
  replaceTargets,
  type Scene,
  type SculptureControls,
} from "./scene";

interface RendererOptions {
  readonly canvas: HTMLCanvasElement;
  readonly initialControls?: Readonly<SculptureControls>;
}

export function createRenderer({ canvas, initialControls }: RendererOptions) {
  let disposed = false;
  const controls = normalizeControls(initialControls ?? DEFAULT_CONTROLS);
  let gpu: Gpu | undefined;
  let output: Surface | undefined;
  let scene: Scene | undefined;
  let input: ReturnType<typeof installPointerInput> | undefined;
  let gui: GUI | undefined;
  let unsubscribeResize: (() => void) | undefined;
  let animationFrame = 0;
  let previous = 0;
  let sawInitialResize = false;
  let sculptureTime = 0;
  let clock = 0;

  const rebuildTargets = () => {
    if (disposed || !gpu || !output || !scene) return;
    try {
      replaceTargets(gpu, scene, output.size, controls.renderScale);
    } catch (error) {
      fail(error);
    }
  };

  const onSurfaceResize = () => {
    if (!sawInitialResize) {
      sawInitialResize = true;
      return;
    }
    rebuildTargets();
  };

  const tick = (now: number) => {
    animationFrame = 0;
    if (disposed) return;
    if (!document.hidden && gpu && output && scene && input) {
      try {
        const deltaTime = Math.max(0, Math.min(0.1, (now - previous) / 1000));
        input.advance(deltaTime);
        clock += deltaTime;
        if (controls.spin) sculptureTime += deltaTime;
        const currentInput = input;
        renderScene(
          gpu,
          scene,
          output,
          () =>
            cameraView(
              currentInput.yaw,
              currentInput.pitch,
              currentInput.radius
            ),
          controls,
          {
            time: sculptureTime,
            clock,
            light: {
              azimuth: currentInput.lightAzimuth,
              elevation: currentInput.lightElevation,
            },
          }
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
      const nextScene = await createScene(gpu, output, controls);
      if (disposed) return;
      scene = nextScene;
      input = installPointerInput(canvas);
      gui = new GUI({
        title: "Glass sculpture",
        container: canvas.parentElement ?? undefined,
        width: 200,
      });
      Object.assign(gui.domElement.style, {
        position: "absolute",
        top: "16px",
        right: "16px",
        zIndex: "10",
      });
      gui
        .add(controls, "shape", { Knot: "knot", Gyroid: "gyroid", Droplets: "droplets" })
        .name("Shape");
      gui
        .add(controls, "glass", {
          Clear: "clear",
          Rose: "rose",
          Cobalt: "cobalt",
          Emerald: "emerald",
        })
        .name("Glass");
      gui
        .add(controls, "light", {
          Studio: "studio",
          Noir: "noir",
          Gel: "gel",
          Golden: "golden",
        })
        .name("Light rig");
      gui.add(controls, "dispersion").name("Dispersion");
      gui.add(controls, "spin").name("Turntable");
      gui
        .add(controls, "renderScale", { "50%": 0.5, "75%": 0.75, "100%": 1 })
        .name("Render scale")
        .onChange(rebuildTargets);

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
