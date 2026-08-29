import { cameraView } from "./camera";
import {
  aspectOf,
  createScene,
  render,
  replaceHdr,
  runCleanups,
} from "./scene";
import { clock, frameLoop, surface, type Gpu } from "vgpu";

interface RendererOptions {
  readonly canvas: HTMLCanvasElement;
}

export function createRenderer({ canvas }: RendererOptions) {
  let disposed = false;
  let failed = false;
  let gpu: Gpu | undefined;
  let input: ReturnType<typeof installOrbitInput> | undefined;
  let loop: { stop(): void } | undefined;
  let unsubscribeResize: (() => void) | undefined;

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    runCleanups([
      () => loop?.stop(),
      () => unsubscribeResize?.(),
      () => input?.dispose(),
      () => gpu?.dispose(),
    ]);
  }

  function fail(error: unknown): never {
    failed = true;
    try {
      dispose();
    } catch {}
    throw error;
  }

  function guard(action: () => void): void {
    try {
      action();
    } catch (error) {
      fail(error);
    }
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
    const output = surface(nextGpu, canvas, { dpr: [1, 2] });
    const scene = await createScene(nextGpu, output);
    if (disposed) return;

    const orbit = installOrbitInput(canvas, guard);
    input = orbit;
    unsubscribeResize = output.onResize(() => {
      if (disposed) return;
      guard(() => {
        if (
          scene.hdr.size[0] !== output.size[0] ||
          scene.hdr.size[1] !== output.size[1]
        ) {
          replaceHdr(nextGpu, scene, output.size);
        }
      });
    });
    const time = clock(nextGpu);
    loop = frameLoop(nextGpu, (currentFrame) => {
      guard(() => {
        if (disposed) return;
        orbit.advance(time.deltaTime);
        render(
          currentFrame,
          scene,
          output,
          cameraView(orbit.yaw, orbit.pitch, aspectOf(output)),
          time.time
        );
      });
    });
  };

  const ready = initialize().catch((error: unknown) => {
    if (disposed && !failed) return;
    fail(error);
  });

  return { ready, dispose };
}

export function installOrbitInput(
  canvas: HTMLCanvasElement,
  guard: (action: () => void) => void = (action) => action()
) {
  let yaw = 0.6;
  let pitch = 0.12;
  let activePointer: number | undefined;
  let lastX = 0;
  let lastY = 0;
  const previousTouchAction = canvas.style.touchAction;
  canvas.style.touchAction = "none";

  const down = (event: PointerEvent) =>
    guard(() => {
      if (!event.isPrimary || activePointer !== undefined) return;
      activePointer = event.pointerId;
      lastX = event.clientX;
      lastY = event.clientY;
      canvas.setPointerCapture?.(event.pointerId);
    });
  const move = (event: PointerEvent) =>
    guard(() => {
      if (event.pointerId !== activePointer) return;
      yaw -= (event.clientX - lastX) * 0.006;
      pitch = Math.max(
        -1.2,
        Math.min(1.2, pitch + (event.clientY - lastY) * 0.006)
      );
      lastX = event.clientX;
      lastY = event.clientY;
    });
  const end = (event: PointerEvent) =>
    guard(() => {
      if (event.pointerId !== activePointer) return;
      releaseCapture(event.pointerId);
      activePointer = undefined;
    });
  const releaseCapture = (pointer: number) => {
    if (canvas.hasPointerCapture?.(pointer))
      canvas.releasePointerCapture(pointer);
  };

  const listeners = [
    ["pointerdown", down],
    ["pointermove", move],
    ["pointerup", end],
    ["pointercancel", end],
  ] as const;
  const controller = new AbortController();
  try {
    for (const [type, listener] of listeners) {
      canvas.addEventListener(type, listener, { signal: controller.signal });
    }
  } catch (error) {
    runCleanups(
      [
        () => controller.abort(),
        () => (canvas.style.touchAction = previousTouchAction),
      ],
      { error }
    );
  }

  return {
    get yaw() {
      return yaw;
    },
    get pitch() {
      return pitch;
    },
    advance(deltaTime: number) {
      if (activePointer === undefined) yaw += deltaTime * 0.09;
    },
    dispose() {
      runCleanups([
        () => controller.abort(),
        () => activePointer !== undefined && releaseCapture(activePointer),
        () => (canvas.style.touchAction = previousTouchAction),
      ]);
    },
  };
}
