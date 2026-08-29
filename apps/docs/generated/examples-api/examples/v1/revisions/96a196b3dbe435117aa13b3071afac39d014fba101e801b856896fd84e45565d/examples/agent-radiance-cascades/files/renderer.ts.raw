import GUI, { type Controller } from "lil-gui";
import { surface, type Gpu, type Surface } from "vgpu";

import {
  createScene,
  destroyScene,
  prepareScene,
  presentScene,
  renderLighting,
  scaledSize,
  type AgentRadianceAnimation,
  type AgentRadianceScene,
  type AgentRadianceView,
} from "./simulation";

const QUALITY = {
  web: {
    label: "Web · 4 rays",
    outputScale: 1,
    maxOutputEdge: 1920,
    maxSceneEdge: 640,
    directionBase: 2,
    framesPerSecond: 24,
  },
  high: {
    label: "High · 9 rays",
    outputScale: 1.25,
    maxOutputEdge: 2560,
    maxSceneEdge: 800,
    directionBase: 3,
    framesPerSecond: 24,
  },
  recording: {
    label: "Recording · 16 rays + 1.5×",
    outputScale: 1.5,
    maxOutputEdge: 3840,
    maxSceneEdge: 900,
    directionBase: 4,
    framesPerSecond: 30,
  },
} as const;

type Quality = keyof typeof QUALITY;
interface Controls {
  view: AgentRadianceView;
  animation: AgentRadianceAnimation;
  quality: Quality;
  paused: boolean;
}

const ANIMATIONS: Record<string, AgentRadianceAnimation> = {
  "Center-out wave": "center-out",
  "Orbiting edge": "edge-orbit",
  "Edges, then center": "edge-then-center",
};
const VIEWS: Record<string, AgentRadianceView> = {
  "Final lighting": "final",
  "Emitter / occluder mask": "emitters",
  "Jump-flood seeds": "jfa",
  "Distance field": "sdf",
  "Cascade 0 atlas": "cascade-0",
  "Cascade 1 atlas": "cascade-1",
  "Cascade 2 atlas": "cascade-2",
  "Cascade 3 atlas": "cascade-3",
  "Cascade 4 atlas": "cascade-4",
  "Cascade 5 atlas": "cascade-5",
};

interface RendererOptions {
  readonly canvas: HTMLCanvasElement;
}

export function createRenderer({ canvas }: RendererOptions) {
  let disposed = false;
  const controls: Controls = {
    view: "final",
    animation: "center-out",
    quality: "web",
    paused: false,
  };
  let gpu: Gpu | undefined;
  let canvasSurface: Surface | undefined;
  let scene: AgentRadianceScene | undefined;
  let scenePrepared = false;
  let sceneGeneration = 0;
  let gui: GUI | undefined;
  let viewController: Controller | undefined;
  let observer: ResizeObserver | undefined;
  let unsubscribeResize: (() => void) | undefined;
  let animationFrame = 0;
  let resizeFrame = 0;
  let pendingSize:
    | { readonly width: number; readonly height: number }
    | undefined;
  let animationTime = 0;
  let lastTimestamp = 0;
  let lastChainTimestamp = -Infinity;
  let dirty = true;

  const viewOptions = (count: number) =>
    Object.fromEntries(
      Object.entries(VIEWS).filter(
        ([, value]) =>
          !value.startsWith("cascade-") || Number(value.slice(8)) < count
      )
    );

  const updateViewOptions = (count: number) => {
    if (
      controls.view.startsWith("cascade-") &&
      Number(controls.view.slice(8)) >= count
    ) {
      controls.view = `cascade-${count - 1}` as AgentRadianceView;
      dirty = true;
    }
    viewController = viewController?.options(viewOptions(count));
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (animationFrame) cancelAnimationFrame(animationFrame);
    if (resizeFrame) cancelAnimationFrame(resizeFrame);
    let firstError: unknown;
    for (const cleanup of [
      () => observer?.disconnect(),
      unsubscribeResize,
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

  const rebuildScene = (reportFailure = true) => {
    if (disposed || !gpu || !canvasSurface) return;
    const quality = QUALITY[controls.quality];
    const size = scaledSize(
      canvasSurface.size[0],
      canvasSurface.size[1],
      1,
      quality.maxSceneEdge
    );
    if (
      scene?.size[0] === size[0] &&
      scene.size[1] === size[1] &&
      scene.directionBase === quality.directionBase
    ) {
      return;
    }

    const next = createScene(gpu, size, quality.directionBase);
    const previous = scene;
    scene = next;
    scenePrepared = false;
    dirty = true;
    updateViewOptions(next.cascadeCount);
    const generation = ++sceneGeneration;
    if (previous) destroyScene(previous);
    const preparation = prepareScene(next, canvasSurface.format).then(() => {
      if (disposed || scene !== next || generation !== sceneGeneration) return;
      scenePrepared = true;
      dirty = true;
    });
    if (reportFailure) {
      void preparation.catch((error: unknown) => {
        if (!disposed && scene === next) fail(error);
      });
    }
    return preparation;
  };

  const onSurfaceResize = () => {
    try {
      rebuildScene();
    } catch (error) {
      fail(error);
    }
  };

  const applyResize = () => {
    resizeFrame = 0;
    const size = pendingSize;
    pendingSize = undefined;
    if (disposed || !size || !canvasSurface) return;
    const quality = QUALITY[controls.quality];
    try {
      canvasSurface.resize(
        scaledSize(
          size.width,
          size.height,
          quality.outputScale,
          quality.maxOutputEdge
        )
      );
      rebuildScene();
    } catch (error) {
      fail(error);
    }
  };

  const measure = () => {
    const { width, height } = canvas.getBoundingClientRect();
    if (disposed || width <= 0 || height <= 0) return;
    pendingSize = { width, height };
    if (!resizeFrame) resizeFrame = requestAnimationFrame(applyResize);
  };

  const tick = (timestamp: number) => {
    animationFrame = 0;
    if (disposed) return;
    if (!document.hidden && scenePrepared && scene && canvasSurface) {
      const delta =
        lastTimestamp > 0
          ? Math.min((timestamp - lastTimestamp) / 1000, 0.1)
          : 0;
      if (!controls.paused) animationTime += delta;
      const interval = 1000 / QUALITY[controls.quality].framesPerSecond;
      try {
        if (
          dirty ||
          (!controls.paused && timestamp - lastChainTimestamp >= interval)
        ) {
          renderLighting(
            scene,
            animationTime,
            controls.view,
            controls.animation
          );
          dirty = false;
          lastChainTimestamp = timestamp;
        }
        presentScene(scene, canvasSurface, controls.view);
      } catch (error) {
        fail(error);
      }
    }
    lastTimestamp = timestamp;
    animationFrame = requestAnimationFrame(tick);
  };

  const installGui = () => {
    gui = new GUI({
      title: "Agent Radiance Cascades",
      container: canvas.parentElement ?? undefined,
      width: 210,
    });
    Object.assign(gui.domElement.style, {
      position: "absolute",
      top: "16px",
      right: "16px",
      zIndex: "10",
    });
    gui
      .add(controls, "animation", ANIMATIONS)
      .name("Animation")
      .onChange(() => {
        animationTime = 0;
        dirty = true;
      });
    gui
      .add(
        controls,
        "quality",
        Object.fromEntries(
          Object.entries(QUALITY).map(([value, settings]) => [
            settings.label,
            value,
          ])
        )
      )
      .name("Quality")
      .onChange(() => {
        lastChainTimestamp = -Infinity;
        dirty = true;
        measure();
      });
    viewController = gui
      .add(controls, "view", viewOptions(scene?.cascadeCount ?? 6))
      .name("View")
      .onChange(() => {
        dirty = true;
      });
    gui
      .add(controls, "paused")
      .name("Paused")
      .onChange(() => {
        dirty = true;
      });
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
    canvasSurface = surface(gpu, canvas, { autoResize: false, dpr: 1 });
    await rebuildScene(false);
    if (disposed) return;
    installGui();
    unsubscribeResize = canvasSurface.onResize(onSurfaceResize);
    observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(measure);
    observer?.observe(canvas);
    measure();
    animationFrame = requestAnimationFrame(tick);
  };

  const ready = initialize().catch((error: unknown) => {
    if (!disposed) fail(error);
  });

  return { ready, dispose };
}
