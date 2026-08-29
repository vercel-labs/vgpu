import {
  DEFAULT_PITCH,
  DEFAULT_YAW,
  MAX_RADIUS,
  MIN_RADIUS,
  ORBIT_RADIUS,
} from "./camera";

const DRAG_SPEED = 0.006;
const WHEEL_SPEED = 0.0016;
const EASE_RATE = 14;

export function installOrbitInput(
  canvas: HTMLCanvasElement,
  options: { yaw?: number; pitch?: number; radius?: number } = {}
) {
  let targetYaw = options.yaw ?? DEFAULT_YAW;
  let targetPitch = clampPitch(options.pitch ?? DEFAULT_PITCH);
  let targetRadius = clampRadius(options.radius ?? ORBIT_RADIUS);
  let yaw = targetYaw;
  let pitch = targetPitch;
  let radius = targetRadius;
  let activePointer: number | undefined;
  let lastX = 0;
  let lastY = 0;
  const previousTouchAction = canvas.style.touchAction;
  canvas.style.touchAction = "none";

  const down = (event: PointerEvent) => {
    if (!event.isPrimary || activePointer !== undefined) return;
    activePointer = event.pointerId;
    lastX = event.clientX;
    lastY = event.clientY;
    canvas.setPointerCapture?.(event.pointerId);
  };
  const move = (event: PointerEvent) => {
    if (event.pointerId !== activePointer) return;
    targetYaw -= (event.clientX - lastX) * DRAG_SPEED;
    targetPitch = clampPitch(
      targetPitch + (event.clientY - lastY) * DRAG_SPEED
    );
    lastX = event.clientX;
    lastY = event.clientY;
  };
  const end = (event: PointerEvent) => {
    if (event.pointerId !== activePointer) return;
    if (canvas.hasPointerCapture?.(event.pointerId)) {
      canvas.releasePointerCapture(event.pointerId);
    }
    activePointer = undefined;
  };
  const wheel = (event: WheelEvent) => {
    event.preventDefault();
    targetRadius = clampRadius(
      targetRadius * Math.exp(event.deltaY * WHEEL_SPEED)
    );
  };

  canvas.addEventListener("pointerdown", down);
  canvas.addEventListener("pointermove", move);
  canvas.addEventListener("pointerup", end);
  canvas.addEventListener("pointercancel", end);
  canvas.addEventListener("wheel", wheel, { passive: false });

  return {
    get yaw() {
      return yaw;
    },
    get pitch() {
      return pitch;
    },
    get radius() {
      return radius;
    },
    advance(deltaTime: number) {
      const blend =
        1 - Math.exp(-EASE_RATE * Math.max(0, Math.min(0.1, deltaTime)));
      yaw += (targetYaw - yaw) * blend;
      pitch += (targetPitch - pitch) * blend;
      radius += (targetRadius - radius) * blend;
    },
    dispose() {
      canvas.removeEventListener("pointerdown", down);
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerup", end);
      canvas.removeEventListener("pointercancel", end);
      canvas.removeEventListener("wheel", wheel);
      let releaseError: unknown;
      try {
        if (
          activePointer !== undefined &&
          canvas.hasPointerCapture?.(activePointer)
        ) {
          canvas.releasePointerCapture(activePointer);
        }
      } catch (error) {
        releaseError = error;
      }
      activePointer = undefined;
      canvas.style.touchAction = previousTouchAction;
      if (releaseError !== undefined) throw releaseError;
    },
  };
}

function clampPitch(pitch: number): number {
  return Math.max(0.02, Math.min(1.05, pitch));
}

function clampRadius(radius: number): number {
  return Math.max(MIN_RADIUS, Math.min(MAX_RADIUS, radius));
}
