import {
  clock,
  frameLoop,
  surface,
  type FrameLoopHandle,
  type Gpu,
  type Surface,
} from "vgpu";

import { installShapeInput, type ShapeInput } from "./pointer-input";
import {
  createLiquidGeoScene,
  destroyLiquidGeoScene,
  renderLiquidGeo,
  resizeLiquidGeoScene,
  type LiquidGeoScene,
} from "./simulation";

interface RendererOptions {
  readonly canvas: HTMLCanvasElement;
}

export function createRenderer({ canvas }: RendererOptions) {
  let disposed = false;
  let failed = false;
  let gpu: Gpu | undefined;
  let output: Surface | undefined;
  let scene: LiquidGeoScene | undefined;
  let input: ShapeInput | undefined;
  let loop: FrameLoopHandle | undefined;
  let resizeCleanup: (() => void) | undefined;
  let intersection: IntersectionObserver | undefined;
  let documentVisible = typeof document === "undefined" || !document.hidden;
  let canvasVisible = true;
  let reducedMotion = false;
  let earthMix = 0;
  let targetEarthMix = 0;

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const cleanup of [
      () => loop?.stop(),
      () => resizeCleanup?.(),
      () => intersection?.disconnect(),
      () => input?.dispose(),
      () => scene && destroyLiquidGeoScene(scene),
      () =>
        document.removeEventListener("visibilitychange", onVisibilityChange),
      () => gpu?.dispose(),
    ]) {
      bestEffort(cleanup);
    }
    loop = undefined;
  };

  const fail = (error: unknown): never => {
    failed = true;
    dispose();
    throw error;
  };

  const startLoop = () => {
    if (disposed || loop || !gpu || !output || !scene || !input) return;
    const timer = clock(gpu);
    loop = frameLoop(gpu, (currentFrame) => {
      if (disposed || !output || !scene || !input) return;
      input.update();
      earthMix = easeMorph(
        earthMix,
        targetEarthMix,
        timer.deltaTime,
        reducedMotion
      );
      renderLiquidGeo(currentFrame, scene, output, {
        time: timer.time,
        deltaTime: timer.deltaTime,
        pointer: input.position,
        pointerStrength: input.strength,
        reducedMotion,
        earthMix,
      });
    });
  };

  const reconcileLoop = () => {
    if (documentVisible && canvasVisible) {
      startLoop();
    } else {
      loop?.stop();
      loop = undefined;
    }
  };

  function onVisibilityChange() {
    documentVisible = !document.hidden;
    reconcileLoop();
  }

  const initialize = async () => {
    const { init } = await import("vgpu");
    if (disposed) return;
    const nextGpu = await init({
      requiredLimits: { maxStorageBuffersInVertexStage: 1 },
    });
    gpu = nextGpu;
    if (disposed) {
      nextGpu.dispose();
      return;
    }

    output = surface(nextGpu, canvas, { dpr: [1, 2] });
    scene = await createLiquidGeoScene(nextGpu, output);
    if (disposed) {
      destroyLiquidGeoScene(scene);
      scene = undefined;
      return;
    }
    input = installShapeInput(canvas);
    reducedMotion =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    resizeCleanup = output.onResize(() => {
      if (!disposed && scene && output) resizeLiquidGeoScene(scene, output);
    });
    document.addEventListener("visibilitychange", onVisibilityChange);
    if (typeof IntersectionObserver !== "undefined") {
      intersection = new IntersectionObserver((entries) => {
        canvasVisible = entries.at(-1)?.isIntersecting ?? canvasVisible;
        reconcileLoop();
      });
      intersection.observe(canvas);
    }
    reconcileLoop();
  };

  const ready = initialize().catch((error: unknown) => {
    if (disposed && !failed) return;
    fail(error);
  });

  const setEarthMix = (value: number) => {
    targetEarthMix = Math.max(0, Math.min(1, value));
  };

  return { ready, dispose, setEarthMix };
}

export function easeMorph(
  current: number,
  target: number,
  deltaTime: number,
  reducedMotion = false
): number {
  if (reducedMotion) return target;
  const next =
    current +
    (target - current) *
      (1 - Math.exp(-2.1 * Math.min(0.1, Math.max(0, deltaTime))));
  return Math.abs(target - next) < 0.0005 ? target : next;
}

function bestEffort(cleanup: () => void): void {
  try {
    cleanup();
  } catch {
    // Cleanup should be idempotent and must not mask the original failure.
  }
}
