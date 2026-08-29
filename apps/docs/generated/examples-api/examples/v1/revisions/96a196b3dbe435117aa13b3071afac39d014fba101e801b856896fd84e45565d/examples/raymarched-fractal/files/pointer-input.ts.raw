import type { Orbit } from "./pipeline";
import { quietly, runAll } from "./lifecycle";

export function createRenderScheduler(
  render: () => void,
  raf: (callback: FrameRequestCallback) => number = requestAnimationFrame,
  cancel: (id: number) => void = cancelAnimationFrame
) {
  let pending: number | undefined;
  let disposed = false;
  return {
    request() {
      if (disposed || pending !== undefined) return;
      pending = raf(() => {
        pending = undefined;
        if (!disposed) render();
      });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (pending !== undefined) cancel(pending);
    },
  };
}

export function installDragOrbit(
  canvas: HTMLCanvasElement,
  orbit: Orbit,
  requestRender: () => void,
  onError: (error: unknown) => never
): () => void {
  let activeId: number | undefined;
  let lastX = 0;
  let lastY = 0;
  let disposed = false;
  const previousTouchAction = canvas.style.touchAction;
  canvas.style.touchAction = "none";

  const guard = (action: () => void) => {
    try {
      action();
    } catch (error) {
      onError(error);
    }
  };
  const down = (event: PointerEvent) =>
    guard(() => {
      if (!event.isPrimary || activeId !== undefined) return;
      activeId = event.pointerId;
      lastX = event.clientX;
      lastY = event.clientY;
      canvas.setPointerCapture(event.pointerId);
    });
  const move = (event: PointerEvent) =>
    guard(() => {
      if (event.pointerId !== activeId) return;
      const dx = event.clientX - lastX;
      const dy = event.clientY - lastY;
      lastX = event.clientX;
      lastY = event.clientY;
      if (dx === 0 && dy === 0) return;
      orbit.yaw -= dx * 0.006;
      orbit.pitch = Math.max(-1.15, Math.min(1.15, orbit.pitch + dy * 0.006));
      requestRender();
    });
  const end = (event: PointerEvent) =>
    guard(() => {
      if (event.pointerId !== activeId) return;
      if (canvas.hasPointerCapture(event.pointerId)) {
        canvas.releasePointerCapture(event.pointerId);
      }
      activeId = undefined;
    });

  const listeners = [
    ["pointerdown", down],
    ["pointermove", move],
    ["pointerup", end],
    ["pointercancel", end],
  ] as const;
  const removeListeners = (count: number) =>
    listeners.slice(0, count).map(
      ([type, listener]) =>
        () =>
          canvas.removeEventListener(type, listener)
    );
  let installed = 0;
  try {
    for (const [type, listener] of listeners) {
      canvas.addEventListener(type, listener);
      installed++;
    }
  } catch (error) {
    quietly(() =>
      runAll([
        ...removeListeners(installed),
        () => {
          canvas.style.touchAction = previousTouchAction;
        },
      ])
    );
    throw error;
  }

  return () => {
    if (disposed) return;
    disposed = true;
    const pointer = activeId;
    activeId = undefined;
    runAll([
      ...removeListeners(listeners.length),
      () => {
        if (pointer !== undefined && canvas.hasPointerCapture(pointer)) {
          canvas.releasePointerCapture(pointer);
        }
      },
      () => {
        canvas.style.touchAction = previousTouchAction;
      },
    ]);
  };
}
