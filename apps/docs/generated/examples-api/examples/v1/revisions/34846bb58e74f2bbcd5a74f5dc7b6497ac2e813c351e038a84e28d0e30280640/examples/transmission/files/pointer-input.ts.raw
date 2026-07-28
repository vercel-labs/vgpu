import { DEFAULT_PITCH, DEFAULT_YAW, MAX_RADIUS, MIN_RADIUS, ORBIT_RADIUS } from './camera';

export interface OrbitInput {
  /** Camera yaw/pitch in radians and orbit radius, eased toward the dragged target. */
  readonly yaw: number;
  readonly pitch: number;
  readonly radius: number;
  advance(deltaTime: number): void;
  dispose(): void;
}

export interface OrbitInputOptions {
  readonly yaw?: number;
  readonly pitch?: number;
  readonly radius?: number;
}

const DRAG_SENSITIVITY = 0.006;
const WHEEL_SENSITIVITY = 0.0016;
/** Pitch stays above the floor plane: below it the camera would look at the plane's back. */
const PITCH_MIN = 0.02;
const PITCH_MAX = 1.05;
/** Exponential ease toward the target, per second. Higher is snappier. */
const EASE_RATE = 14;

/**
 * Drag to orbit, wheel to dolly. Nothing moves on its own: a still glass cube is the
 * point of the example, and the refraction has to be readable while the camera is idle.
 */
export function installOrbitInput(canvas: HTMLCanvasElement, options: OrbitInputOptions = {}): OrbitInput {
  let targetYaw = options.yaw ?? DEFAULT_YAW;
  let targetPitch = clampPitch(options.pitch ?? DEFAULT_PITCH);
  let targetRadius = clampRadius(options.radius ?? ORBIT_RADIUS);
  let currentYaw = targetYaw;
  let currentPitch = targetPitch;
  let currentRadius = targetRadius;
  let activePointer: number | undefined;
  let lastX = 0;
  let lastY = 0;

  const previousTouchAction = canvas.style.touchAction;
  canvas.style.touchAction = 'none';

  const down = (event: PointerEvent) => {
    if (!event.isPrimary || activePointer !== undefined) return;
    activePointer = event.pointerId;
    lastX = event.clientX;
    lastY = event.clientY;
    canvas.setPointerCapture?.(event.pointerId);
  };
  const move = (event: PointerEvent) => {
    if (event.pointerId !== activePointer) return;
    targetYaw -= (event.clientX - lastX) * DRAG_SENSITIVITY;
    targetPitch = clampPitch(targetPitch + (event.clientY - lastY) * DRAG_SENSITIVITY);
    lastX = event.clientX;
    lastY = event.clientY;
  };
  const end = (event: PointerEvent) => {
    if (event.pointerId !== activePointer) return;
    if (canvas.hasPointerCapture?.(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    activePointer = undefined;
  };
  const wheel = (event: WheelEvent) => {
    event.preventDefault();
    targetRadius = clampRadius(targetRadius * Math.exp(event.deltaY * WHEEL_SENSITIVITY));
  };

  canvas.addEventListener('pointerdown', down);
  canvas.addEventListener('pointermove', move);
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('wheel', wheel, { passive: false });

  return {
    get yaw() { return currentYaw; },
    get pitch() { return currentPitch; },
    get radius() { return currentRadius; },
    advance(deltaTime: number) {
      // Frame-rate independent ease: the same curve at 60 and 144 Hz, and it settles
      // exactly on the target instead of drifting past it.
      const t = 1 - Math.exp(-EASE_RATE * Math.max(0, Math.min(0.1, deltaTime)));
      currentYaw += (targetYaw - currentYaw) * t;
      currentPitch += (targetPitch - currentPitch) * t;
      currentRadius += (targetRadius - currentRadius) * t;
    },
    dispose() {
      canvas.removeEventListener('pointerdown', down);
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerup', end);
      canvas.removeEventListener('pointercancel', end);
      canvas.removeEventListener('wheel', wheel);
      if (activePointer !== undefined && canvas.hasPointerCapture?.(activePointer)) canvas.releasePointerCapture(activePointer);
      activePointer = undefined;
      canvas.style.touchAction = previousTouchAction;
    },
  };
}

function clampPitch(pitch: number): number {
  return Math.max(PITCH_MIN, Math.min(PITCH_MAX, pitch));
}

function clampRadius(radius: number): number {
  return Math.max(MIN_RADIUS, Math.min(MAX_RADIUS, radius));
}
