import { dolly, orbit, type OrbitRig } from "vgpu/scene";

const LIMITS = {
  minPitch: -0.05,
  maxPitch: 1.35,
  minDistance: 20,
  maxDistance: 700,
} as const;

interface OrbitInputElement {
  addEventListener(type: string, listener: EventListener, options?: AddEventListenerOptions): void;
  removeEventListener(type: string, listener: EventListener, options?: EventListenerOptions): void;
  setPointerCapture?(pointerId: number): void;
  releasePointerCapture?(pointerId: number): void;
}

export function installOrbitInput(element: OrbitInputElement, goal: OrbitRig) {
  let disposed = false;
  let pointer: number | undefined;
  let lastX = 0;
  let lastY = 0;

  const pointerDown: EventListener = (event) => {
    const value = event as PointerEvent;
    if (value.button !== 0) return;
    pointer = value.pointerId;
    lastX = value.clientX;
    lastY = value.clientY;
    element.setPointerCapture?.(value.pointerId);
  };
  const pointerMove: EventListener = (event) => {
    const value = event as PointerEvent;
    if (value.pointerId !== pointer) return;
    const deltaX = value.clientX - lastX;
    const deltaY = value.clientY - lastY;
    lastX = value.clientX;
    lastY = value.clientY;
    orbit(goal, -deltaX * 0.005, deltaY * 0.005, LIMITS);
  };
  const pointerUp: EventListener = (event) => {
    const value = event as PointerEvent;
    if (value.pointerId !== pointer) return;
    element.releasePointerCapture?.(value.pointerId);
    pointer = undefined;
  };
  const wheel: EventListener = (event) => {
    const value = event as WheelEvent;
    value.preventDefault();
    dolly(goal, Math.exp(value.deltaY * 0.001), LIMITS);
  };
  const listeners = [
    ["pointerdown", pointerDown, undefined],
    ["pointermove", pointerMove, undefined],
    ["pointerup", pointerUp, undefined],
    ["pointercancel", pointerUp, undefined],
    ["wheel", wheel, { passive: false }],
  ] as const;
  let installed = 0;
  try {
    for (const [type, listener, options] of listeners) {
      element.addEventListener(type, listener, options);
      installed++;
    }
  } catch (error) {
    for (let index = installed - 1; index >= 0; index--) {
      const [type, listener] = listeners[index]!;
      element.removeEventListener(type, listener);
    }
    throw error;
  }

  return {
    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (pointer !== undefined) element.releasePointerCapture?.(pointer);
      for (const [type, listener] of listeners) element.removeEventListener(type, listener);
      pointer = undefined;
    },
  };
}
