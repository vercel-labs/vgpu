import {
  DEFAULT_PITCH,
  DEFAULT_YAW,
  ORBIT_RADIUS,
  clampPitch,
  clampRadius,
} from "./camera";

const DRAG_SPEED = 0.006;
const WHEEL_SPEED = 0.0016;
const EASE_RATE = 14;
const LIGHT_EASE_RATE = 5;
const HOVER_HOLD_SECONDS = 2.5;
const SWEEP_AZIMUTH_AMPLITUDE = 1.6;
const SWEEP_AZIMUTH_OFFSET = 0.9;

export interface PointerInputOptions {
  readonly yaw?: number;
  readonly pitch?: number;
  readonly radius?: number;
}

/**
 * Dragging orbits the camera and the wheel dollies it. Merely moving the pointer
 * over the canvas steers the key light: left/right swings it around the
 * sculpture, up/down raises it. Once the pointer rests for a moment the light
 * goes back to its slow automatic sweep.
 */
export function installPointerInput(
  canvas: HTMLCanvasElement,
  options: PointerInputOptions = {}
) {
  let targetYaw = options.yaw ?? DEFAULT_YAW;
  let targetPitch = clampPitch(options.pitch ?? DEFAULT_PITCH);
  let targetRadius = clampRadius(options.radius ?? ORBIT_RADIUS);
  let yaw = targetYaw;
  let pitch = targetPitch;
  let radius = targetRadius;
  let targetLightAzimuth = SWEEP_AZIMUTH_OFFSET;
  let targetLightElevation = 0.5;
  let lightAzimuth = targetLightAzimuth;
  let lightElevation = targetLightElevation;
  let hoverRemaining = 0;
  let elapsed = 0;
  let activePointer: number | undefined;
  let lastX = 0;
  let lastY = 0;
  const previousTouchAction = canvas.style.touchAction;
  canvas.style.touchAction = "none";

  const steerLight = (event: PointerEvent) => {
    const width = Math.max(1, canvas.clientWidth);
    const height = Math.max(1, canvas.clientHeight);
    const rect = canvas.getBoundingClientRect?.();
    const x = (event.clientX - (rect?.left ?? 0)) / width;
    const y = (event.clientY - (rect?.top ?? 0)) / height;
    targetLightAzimuth = (x - 0.5) * 3.6;
    targetLightElevation = 0.15 + (1 - y) * 1.0;
    hoverRemaining = HOVER_HOLD_SECONDS;
  };
  const down = (event: PointerEvent) => {
    if (!event.isPrimary || activePointer !== undefined) return;
    activePointer = event.pointerId;
    lastX = event.clientX;
    lastY = event.clientY;
    canvas.setPointerCapture?.(event.pointerId);
  };
  const move = (event: PointerEvent) => {
    if (activePointer === undefined) {
      steerLight(event);
      return;
    }
    if (event.pointerId !== activePointer) return;
    targetYaw += (event.clientX - lastX) * DRAG_SPEED;
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
    get lightAzimuth() {
      return lightAzimuth;
    },
    get lightElevation() {
      return lightElevation;
    },
    get hovering() {
      return hoverRemaining > 0;
    },
    advance(deltaTime: number) {
      const dt = Math.max(0, Math.min(0.1, deltaTime));
      elapsed += dt;
      hoverRemaining = Math.max(0, hoverRemaining - dt);
      if (hoverRemaining <= 0) {
        targetLightAzimuth =
          Math.sin(elapsed * 0.23) * SWEEP_AZIMUTH_AMPLITUDE +
          SWEEP_AZIMUTH_OFFSET;
        targetLightElevation = 0.45 + 0.3 * Math.sin(elapsed * 0.37);
      }
      const blend = 1 - Math.exp(-EASE_RATE * dt);
      yaw += (targetYaw - yaw) * blend;
      pitch += (targetPitch - pitch) * blend;
      radius += (targetRadius - radius) * blend;
      const lightBlend = 1 - Math.exp(-LIGHT_EASE_RATE * dt);
      lightAzimuth += (targetLightAzimuth - lightAzimuth) * lightBlend;
      lightElevation += (targetLightElevation - lightElevation) * lightBlend;
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
