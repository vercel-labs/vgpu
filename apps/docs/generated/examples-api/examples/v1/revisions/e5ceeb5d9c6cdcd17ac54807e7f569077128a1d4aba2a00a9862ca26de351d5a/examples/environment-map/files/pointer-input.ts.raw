export interface OrbitInput {
  /** Camera yaw/pitch in radians, advanced by `advance()` and by pointer drags. */
  readonly yaw: number;
  readonly pitch: number;
  advance(deltaTime: number): void;
  dispose(): void;
}

export interface OrbitInputOptions {
  readonly yaw?: number;
  readonly pitch?: number;
}

const DRIFT_SPEED = 0.09;
const DRAG_SENSITIVITY = 0.006;
const PITCH_LIMIT = 1.2;

/** Drag to look around the environment; the camera drifts on its own while idle. */
export function installOrbitInput(canvas: HTMLCanvasElement, options: OrbitInputOptions = {}): OrbitInput {
  let currentYaw = options.yaw ?? 0.6;
  let currentPitch = options.pitch ?? 0.12;
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
    currentYaw -= (event.clientX - lastX) * DRAG_SENSITIVITY;
    currentPitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, currentPitch + (event.clientY - lastY) * DRAG_SENSITIVITY));
    lastX = event.clientX;
    lastY = event.clientY;
  };
  const end = (event: PointerEvent) => {
    if (event.pointerId !== activePointer) return;
    if (canvas.hasPointerCapture?.(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    activePointer = undefined;
  };

  canvas.addEventListener('pointerdown', down);
  canvas.addEventListener('pointermove', move);
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);

  return {
    get yaw() { return currentYaw; },
    get pitch() { return currentPitch; },
    advance(deltaTime: number) {
      // Dragging owns the yaw while the pointer is down, so the drift never fights it.
      if (activePointer === undefined) currentYaw += deltaTime * DRIFT_SPEED;
    },
    dispose() {
      canvas.removeEventListener('pointerdown', down);
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerup', end);
      canvas.removeEventListener('pointercancel', end);
      if (activePointer !== undefined && canvas.hasPointerCapture?.(activePointer)) canvas.releasePointerCapture(activePointer);
      activePointer = undefined;
      canvas.style.touchAction = previousTouchAction;
    },
  };
}
