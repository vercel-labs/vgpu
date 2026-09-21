import GUI, { type Controller } from "lil-gui";
import { surface, type Gpu, type Surface } from "vgpu";

import { installLightPaintInput } from "./pointer-input";
import {
  createScene,
  destroyScene,
  prepareScene,
  presentScene,
  runChain,
  type RadianceScene,
  type RadianceView,
} from "./simulation";

const RADIANCE_VIEWS: readonly {
  readonly value: RadianceView;
  readonly label: string;
}[] = [
  { value: "final", label: "Final" },
  { value: "emitters", label: "Emitters" },
  { value: "sdf", label: "Distance field" },
  ...Array.from({ length: 6 }, (_, index) => ({
    value: `cascade-${index}` as RadianceView,
    label: `Cascade ${index} atlas`,
  })),
];

interface RendererOptions {
  readonly canvas: HTMLCanvasElement;
}

export function createRenderer({ canvas }: RendererOptions) {
  let disposed = false;
  const controls: { view: RadianceView } = { view: "final" };
  let gpu: Gpu | undefined;
  let canvasSurface: Surface | undefined;
  let scene: RadianceScene | undefined;
  let input: ReturnType<typeof installLightPaintInput> | undefined;
  let gui: GUI | undefined;
  let viewController: Controller | undefined;
  let observer: ResizeObserver | undefined;
  let unsubscribeResize: (() => void) | undefined;
  let animationFrame = 0;
  let resizeFrame = 0;
  let pendingSize:
    | { readonly width: number; readonly height: number; readonly dpr: number }
    | undefined;
  let lastDpr = typeof window === "undefined" ? 1 : window.devicePixelRatio;
  let sawInitialResize = false;
  let rebuilding = false;
  let dirty = true;
  let clearRequested = false;

  const viewOptions = (count: number) =>
    Object.fromEntries(
      RADIANCE_VIEWS.filter(
        ({ value }) =>
          !value.startsWith("cascade-") ||
          Number(value.slice("cascade-".length)) < count
      ).map(({ value, label }) => [label, value])
    );

  const updateViewOptions = (count: number) => {
    if (
      controls.view.startsWith("cascade-") &&
      Number(controls.view.slice(8)) >= count
    ) {
      controls.view = `cascade-${count - 1}` as RadianceView;
      dirty = true;
    }
    viewController = viewController?.options(viewOptions(count));
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (animationFrame) cancelAnimationFrame(animationFrame);
    if (resizeFrame) cancelAnimationFrame(resizeFrame);
    observer?.disconnect();
    if (typeof window !== "undefined") {
      window.removeEventListener("resize", onWindowResize);
    }
    let firstError: unknown;
    for (const cleanup of [
      unsubscribeResize,
      () => input?.dispose(),
      () => gui?.destroy(),
      () => gpu?.dispose(),
    ]) {
      try {
        cleanup?.();
      } catch (error) {
        firstError ??= error;
      }
    }
    if (firstError) throw firstError;
  };

  const fail = (error: unknown): never => {
    try {
      dispose();
    } catch {
      // Keep the operation failure primary after best-effort teardown.
    }
    throw error;
  };

  const rebuildScene = () => {
    if (disposed || !gpu || !canvasSurface) return;
    rebuilding = true;
    try {
      const next = createScene(gpu, canvasSurface.size);
      const previous = scene;
      scene = next;
      if (previous) destroyScene(previous);
      updateViewOptions(next.cascadeCount);
      clearRequested = true;
      dirty = true;
      void prepareScene(next, canvasSurface.format).catch((error: unknown) => {
        if (!disposed && scene === next) fail(error);
      });
    } catch (error) {
      fail(error);
    } finally {
      rebuilding = false;
    }
  };

  const onSurfaceResize = () => {
    if (!sawInitialResize) {
      sawInitialResize = true;
      return;
    }
    if (!rebuilding) rebuildScene();
  };

  const applyResize = () => {
    resizeFrame = 0;
    const size = pendingSize;
    pendingSize = undefined;
    if (disposed || !size || !canvasSurface) return;
    try {
      canvasSurface.resize([
        Math.max(1, Math.round(size.width * size.dpr)),
        Math.max(1, Math.round(size.height * size.dpr)),
      ]);
    } catch (error) {
      fail(error);
    }
  };

  const measure = () => {
    const { width, height } = canvas.getBoundingClientRect();
    if (disposed || width <= 0 || height <= 0) return;
    pendingSize = {
      width,
      height,
      dpr: Math.min(2, Math.max(1, window.devicePixelRatio || 1)),
    };
    if (!resizeFrame) resizeFrame = requestAnimationFrame(applyResize);
  };

  function onWindowResize() {
    if (window.devicePixelRatio === lastDpr) return;
    lastDpr = window.devicePixelRatio;
    measure();
  }

  const tick = () => {
    animationFrame = 0;
    if (disposed) return;
    if (!document.hidden && gpu && canvasSurface && scene && input) {
      try {
        const segment = input.take();
        if (segment) dirty = true;
        if (dirty) {
          runChain(scene, {
            segment,
            keepPrevious: !clearRequested,
            view: controls.view,
          });
          clearRequested = false;
          dirty = false;
        }
        presentScene(scene, canvasSurface, controls.view);
      } catch (error) {
        fail(error);
      }
    }
    animationFrame = requestAnimationFrame(tick);
  };

  const initialize = async () => {
    const { init } = await import("vgpu");
    if (disposed) return;
    const nextGpu = await init();
    if (disposed) {
      nextGpu.dispose();
      return;
    }
    gpu = nextGpu;
    canvasSurface = surface(gpu, canvas, { autoResize: false, dpr: [1, 2] });
    scene = createScene(gpu, canvasSurface.size);
    await prepareScene(scene, canvasSurface.format);
    if (disposed) return;

    input = installLightPaintInput(canvas);
    gui = new GUI({
      title: "Radiance Cascades",
      container: canvas.parentElement ?? undefined,
      width: 190,
    });
    Object.assign(gui.domElement.style, {
      position: "absolute",
      top: "16px",
      right: "16px",
      zIndex: "10",
    });
    viewController = gui
      .add(controls, "view", viewOptions(scene.cascadeCount))
      .name("View")
      .onChange(() => {
        dirty = true;
      });
    gui
      .add(
        {
          clear() {
            clearRequested = true;
            dirty = true;
          },
        },
        "clear"
      )
      .name("Clear canvas");

    unsubscribeResize = canvasSurface.onResize(onSurfaceResize);
    observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(measure);
    observer?.observe(canvas);
    window.addEventListener("resize", onWindowResize);
    measure();
    animationFrame = requestAnimationFrame(tick);
  };

  const ready = initialize().catch((error: unknown) => {
    if (!disposed) fail(error);
  });

  return { ready, dispose };
}
