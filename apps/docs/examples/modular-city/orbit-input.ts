import { dolly, orbit, type OrbitRig } from "vgpu/scene";

export const ORBIT_LIMITS = {
  minPitch: 0.28,
  maxPitch: 1.36,
  minDistance: 34,
  maxDistance: 210,
} as const;

const PAN_LIMIT = 34;
const TAP_DISTANCE = 6;
const TAP_DURATION = 500;

export interface TapEvent {
  readonly clientX: number;
  readonly clientY: number;
  readonly pointerType: string;
}

export interface OrbitInputOptions {
  onTap(event: TapEvent): void;
}

export interface OrbitInput {
  /** A pointer hovers or presses the canvas (auto-orbit pauses). */
  readonly engaged: boolean;
  dispose(): void;
}

interface OrbitInputElement {
  addEventListener(type: string, listener: EventListener, options?: AddEventListenerOptions): void;
  removeEventListener(type: string, listener: EventListener, options?: EventListenerOptions): void;
  setPointerCapture?(pointerId: number): void;
  releasePointerCapture?(pointerId: number): void;
  hasPointerCapture?(pointerId: number): boolean;
}

interface TrackedPointer {
  x: number;
  y: number;
  readonly startX: number;
  readonly startY: number;
  readonly startTime: number;
  readonly type: string;
  readonly pan: boolean;
}

/** Ground-plane pan: moves the rig pan along the camera's horizontal right and forward axes. */
export function panGround(goal: OrbitRig, right: number, forward: number): void {
  const sin = Math.sin(goal.yaw);
  const cos = Math.cos(goal.yaw);
  const x = goal.pan[0]! + right * cos - forward * sin;
  const z = goal.pan[2]! - right * sin - forward * cos;
  goal.pan[0] = Math.min(PAN_LIMIT, Math.max(-PAN_LIMIT, x));
  goal.pan[2] = Math.min(PAN_LIMIT, Math.max(-PAN_LIMIT, z));
}

/**
 * Drag orbits, right/shift-drag (or two-finger drag) pans, wheel and pinch zoom, and a short
 * press without movement reports a tap for picking.
 */
export function installOrbitInput(
  element: OrbitInputElement,
  goal: OrbitRig,
  options: OrbitInputOptions
): OrbitInput {
  let disposed = false;
  let hovering = false;
  const pointers = new Map<number, TrackedPointer>();
  let pinchDistance = 0;
  let pinchX = 0;
  let pinchY = 0;
  let multiTouch = false;

  // releasePointerCapture throws NotFoundError for a pointer that is no longer active.
  const release = (pointerId: number) => {
    if (element.hasPointerCapture?.(pointerId)) element.releasePointerCapture?.(pointerId);
  };

  const pinchState = () => {
    const [a, b] = [...pointers.values()];
    return {
      distance: Math.hypot(a!.x - b!.x, a!.y - b!.y),
      x: (a!.x + b!.x) / 2,
      y: (a!.y + b!.y) / 2,
    };
  };

  const pointerDown: EventListener = (event) => {
    const value = event as PointerEvent;
    if (value.pointerType === "mouse" && value.button !== 0 && value.button !== 2) return;
    pointers.set(value.pointerId, {
      x: value.clientX,
      y: value.clientY,
      startX: value.clientX,
      startY: value.clientY,
      startTime: value.timeStamp,
      type: value.pointerType,
      pan: value.button === 2 || value.shiftKey,
    });
    element.setPointerCapture?.(value.pointerId);
    if (pointers.size === 2) {
      multiTouch = true;
      ({ distance: pinchDistance, x: pinchX, y: pinchY } = pinchState());
    }
  };

  const pointerMove: EventListener = (event) => {
    const value = event as PointerEvent;
    const pointer = pointers.get(value.pointerId);
    if (!pointer) return;
    const deltaX = value.clientX - pointer.x;
    const deltaY = value.clientY - pointer.y;
    pointer.x = value.clientX;
    pointer.y = value.clientY;
    if (pointers.size >= 2) {
      const next = pinchState();
      if (pinchDistance > 0 && next.distance > 0) dolly(goal, pinchDistance / next.distance, ORBIT_LIMITS);
      const scale = goal.distance * 0.0016;
      panGround(goal, -(next.x - pinchX) * scale, (next.y - pinchY) * scale);
      ({ distance: pinchDistance, x: pinchX, y: pinchY } = next);
      return;
    }
    if (pointer.pan) {
      const scale = goal.distance * 0.0016;
      panGround(goal, -deltaX * scale, deltaY * scale);
    } else {
      orbit(goal, -deltaX * 0.005, deltaY * 0.004, ORBIT_LIMITS);
    }
  };

  const pointerUp: EventListener = (event) => {
    const value = event as PointerEvent;
    const pointer = pointers.get(value.pointerId);
    if (!pointer) return;
    pointers.delete(value.pointerId);
    release(value.pointerId);
    const moved = Math.hypot(value.clientX - pointer.startX, value.clientY - pointer.startY);
    const tap =
      event.type === "pointerup" &&
      !multiTouch &&
      !pointer.pan &&
      moved < TAP_DISTANCE &&
      value.timeStamp - pointer.startTime < TAP_DURATION;
    if (pointers.size === 0) multiTouch = false;
    if (pointers.size === 1) pinchDistance = 0;
    if (tap) options.onTap({ clientX: value.clientX, clientY: value.clientY, pointerType: value.pointerType });
  };

  const wheel: EventListener = (event) => {
    const value = event as WheelEvent;
    value.preventDefault();
    dolly(goal, Math.exp(value.deltaY * 0.0012), ORBIT_LIMITS);
  };
  const contextMenu: EventListener = (event) => event.preventDefault();
  const pointerEnter: EventListener = (event) => {
    if ((event as PointerEvent).pointerType === "mouse") hovering = true;
  };
  const pointerLeave: EventListener = () => {
    hovering = false;
  };

  const listeners = [
    ["pointerdown", pointerDown, undefined],
    ["pointermove", pointerMove, undefined],
    ["pointerup", pointerUp, undefined],
    ["pointercancel", pointerUp, undefined],
    ["pointerenter", pointerEnter, undefined],
    ["pointerleave", pointerLeave, undefined],
    ["contextmenu", contextMenu, undefined],
    ["wheel", wheel, { passive: false }],
  ] as const;
  let installed = 0;
  try {
    for (const [type, listener, listenerOptions] of listeners) {
      element.addEventListener(type, listener, listenerOptions);
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
    get engaged() {
      return hovering || pointers.size > 0;
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const pointerId of pointers.keys()) release(pointerId);
      for (const [type, listener] of listeners) element.removeEventListener(type, listener);
      pointers.clear();
      hovering = false;
    },
  };
}
