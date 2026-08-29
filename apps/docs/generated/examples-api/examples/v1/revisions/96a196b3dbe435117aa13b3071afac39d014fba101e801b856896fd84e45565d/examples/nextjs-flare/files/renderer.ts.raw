import type { Gpu } from "vgpu";

import { rasterizeLogo } from "./logo-raster";
import {
  backingDimensions,
  canvasRaster,
  FlarePipeline,
  followLight,
  LOGO_CENTER,
  mapAutonomousLight,
  runCleanups,
  type FlarePlacement,
  type Point,
} from "./pipeline";

type RenderSize = Readonly<{ width: number; height: number; dpr: number }>;

const FRAME_INTERVAL_MS = 33;
const PULSE_HOLD_SECONDS = 0.35;

export function createRenderer({
  canvas,
}: {
  readonly canvas: HTMLCanvasElement;
}) {
  let disposed = false;
  let failed = false;
  let gpu: Gpu | undefined;
  let pipeline: FlarePipeline | undefined;
  let placement: FlarePlacement | undefined;
  let light: Point = LOGO_CENTER;
  let pointer: Point | undefined;
  let pulseHold = 0;
  let frameIndex = 0;
  let staticDirty = true;
  let lastTime = 0;
  let lastRender = -Infinity;
  let animationFrame = 0;
  let observer: ResizeObserver | undefined;
  let pendingSize: RenderSize | undefined;
  let resizeTask: Promise<void> | undefined;
  let resizeGeneration = 0;
  let rasterAbort: AbortController | undefined;
  let appliedBacking: Point = [0, 0];
  let appliedSupersample = 0;

  const applySize = async (size: RenderSize, generation: number) => {
    if (!pipeline) return;
    const backing = backingDimensions(size.width, size.height, size.dpr);
    const supersample = size.dpr < 1.5 ? 2 : 1;
    if (
      backing[0] === appliedBacking[0] &&
      backing[1] === appliedBacking[1] &&
      supersample === appliedSupersample
    ) {
      return;
    }

    const controller = new AbortController();
    rasterAbort = controller;
    const reference = Math.min(backing[0], backing[1]);
    let logo: HTMLCanvasElement;
    try {
      logo = await rasterizeLogo(reference * supersample, controller.signal);
    } catch (error) {
      if (controller.signal.aborted) return;
      throw error;
    } finally {
      if (rasterAbort === controller) rasterAbort = undefined;
    }
    if (disposed || generation !== resizeGeneration) return;

    const nextPlacement = await pipeline.replace(
      backing,
      supersample,
      canvasRaster(logo),
      () => disposed || generation !== resizeGeneration
    );
    if (!nextPlacement) return;
    placement = nextPlacement;
    appliedBacking = backing;
    appliedSupersample = supersample;
    staticDirty = true;
  };

  const drainResizes = async () => {
    while (pendingSize && !disposed) {
      const size = pendingSize;
      pendingSize = undefined;
      await applySize(size, resizeGeneration);
    }
  };

  const resize = (size: RenderSize): Promise<void> => {
    if (disposed || size.width <= 0 || size.height <= 0)
      return Promise.resolve();
    pendingSize = size;
    resizeGeneration += 1;
    rasterAbort?.abort();
    resizeTask ??= drainResizes()
      .catch((error: unknown) => {
        if (disposed && !failed) return;
        fail(error);
      })
      .finally(() => {
        resizeTask = undefined;
      });
    return resizeTask;
  };

  const measure = () =>
    guard(() => {
      const rect = canvas.getBoundingClientRect();
      void resize({
        width: rect.width,
        height: rect.height,
        dpr: window.devicePixelRatio || 1,
      });
    });

  const handlePointerMove = (event: PointerEvent) => {
    if (event.pointerType === "touch") return;
    guard(() => {
      const rect = canvas.getBoundingClientRect();
      pointer = [
        Math.min(
          1,
          Math.max(0, (event.clientX - rect.left) / Math.max(1, rect.width))
        ),
        Math.min(
          1,
          Math.max(0, (event.clientY - rect.top) / Math.max(1, rect.height))
        ),
      ];
    });
  };

  const handlePointerLeave = () => {
    pointer = undefined;
  };

  const frameLoop = (now: number) => {
    if (disposed) return;
    guard(() => {
      animationFrame = requestAnimationFrame(frameLoop);
      const activePipeline = pipeline;
      if (now - lastRender < FRAME_INTERVAL_MS || !placement || !activePipeline)
        return;
      lastRender = now;
      const time = now / 1000;
      const dt = Math.min(Math.max(time - lastTime, 0), 0.05);
      lastTime = time;
      const target = pointer ?? mapAutonomousLight(time, placement);
      light = followLight(light, target, dt);
      pulseHold +=
        ((pointer ? 1 : 0) - pulseHold) *
        (1 - Math.exp(-dt / PULSE_HOLD_SECONDS));
      activePipeline.setFrameUniforms(
        placement,
        light,
        frameIndex,
        time,
        pulseHold
      );
      activePipeline.draw(staticDirty);
      staticDirty = false;
      frameIndex += 1;
    });
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    resizeGeneration += 1;
    runCleanups([
      () => rasterAbort?.abort(),
      () => {
        if (animationFrame) cancelAnimationFrame(animationFrame);
      },
      () => observer?.disconnect(),
      () => canvas.removeEventListener("pointermove", handlePointerMove),
      () => canvas.removeEventListener("pointerleave", handlePointerLeave),
      () => canvas.removeEventListener("pointercancel", handlePointerLeave),
      () => gpu?.dispose(),
    ]);
  };

  function fail(error: unknown): never {
    failed = true;
    try {
      dispose();
    } catch {
      // Teardown must not replace the live or initialization failure.
    }
    throw error;
  }

  function guard<T>(work: () => T): T {
    try {
      return work();
    } catch (error) {
      return fail(error);
    }
  }

  const initialize = async () => {
    const { init, surface } = await import("vgpu");
    if (disposed) return;
    const nextGpu = await init({ label: "nextjs-flare-example" });
    if (disposed) {
      try {
        nextGpu.dispose();
      } catch {
        // Intentional stale initialization is quiet.
      }
      return;
    }
    gpu = nextGpu;
    const output = surface(gpu, canvas, {
      autoResize: false,
      alphaMode: "opaque",
      format: "bgra8unorm",
    });
    pipeline = new FlarePipeline(gpu, output);
    const rect = canvas.getBoundingClientRect();
    await resize({
      width: Math.max(1, rect.width),
      height: Math.max(1, rect.height),
      dpr: window.devicePixelRatio || 1,
    });
    if (disposed) return;
    light = placement?.logoCenter ?? LOGO_CENTER;
    canvas.addEventListener("pointermove", handlePointerMove);
    canvas.addEventListener("pointerleave", handlePointerLeave);
    canvas.addEventListener("pointercancel", handlePointerLeave);
    observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(measure);
    observer?.observe(canvas);
    animationFrame = requestAnimationFrame(frameLoop);
  };

  const ready = initialize().catch((error: unknown) => {
    if (disposed && !failed) return;
    fail(error);
  });

  return { ready, resize, dispose };
}
