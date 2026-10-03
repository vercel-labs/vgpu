/**
 * Canvas input: drag to orbit, wheel or pinch to zoom, tap to release a marble, and the
 * same actions from the keyboard while the canvas has focus.
 */
export interface InputActions {
  orbit(deltaYaw: number, deltaPitch: number): void;
  /** Multiplies the camera distance; < 1 moves closer. */
  zoom(factor: number): void;
  release(): void;
  releaseBatch(): void;
  togglePause(): void;
  /** One fixed step; the renderer ignores it unless paused. */
  step(): void;
  reset(): void;
  /** Back to the default orbit and zoom without touching the simulation. */
  resetView(): void;
}

export interface Input {
  dispose(): void;
}

const DRAG_YAW_PER_PIXEL = 0.006;
const DRAG_PITCH_PER_PIXEL = 0.005;
const KEY_RADIANS = 0.12;
const KEY_ZOOM = 1.12;
/** A press that moves less than this and lifts quickly is a tap, not an orbit. */
const TAP_SLOP = 6;
const TAP_MS = 350;

interface Press {
  x: number;
  y: number;
  readonly startX: number;
  readonly startY: number;
  readonly startTime: number;
}

export function attachInput(
  canvas: HTMLCanvasElement,
  actions: InputActions,
  guard: (action: () => void) => void = (action) => action(),
): Input {
  const presses = new Map<number, Press>();
  let pinchDistance = 0;
  // A gesture that ever used two pointers never ends as a tap.
  let multiTouch = false;
  const controller = new AbortController();
  const { signal } = controller;

  const spread = () => {
    const [a, b] = [...presses.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  };

  canvas.addEventListener(
    'pointerdown',
    (event) =>
      guard(() => {
        if (event.button !== 0 || presses.size >= 2) return;
        presses.set(event.pointerId, {
          x: event.clientX,
          y: event.clientY,
          startX: event.clientX,
          startY: event.clientY,
          startTime: event.timeStamp,
        });
        multiTouch = presses.size > 1;
        canvas.setPointerCapture?.(event.pointerId);
        pinchDistance = spread();
      }),
    { signal },
  );
  canvas.addEventListener(
    'pointermove',
    (event) =>
      guard(() => {
        const press = presses.get(event.pointerId);
        if (!press) return;
        const dx = event.clientX - press.x;
        const dy = event.clientY - press.y;
        press.x = event.clientX;
        press.y = event.clientY;
        if (presses.size === 2) {
          const distance = spread();
          if (pinchDistance > 0 && distance > 0) actions.zoom(pinchDistance / distance);
          pinchDistance = distance;
          return;
        }
        actions.orbit(-dx * DRAG_YAW_PER_PIXEL, dy * DRAG_PITCH_PER_PIXEL);
      }),
    { signal },
  );
  const end = (event: PointerEvent) =>
    guard(() => {
      const press = presses.get(event.pointerId);
      if (!press) return;
      presses.delete(event.pointerId);
      if (canvas.hasPointerCapture?.(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
      pinchDistance = spread();
      const travel = Math.hypot(event.clientX - press.startX, event.clientY - press.startY);
      const tap = event.type === 'pointerup' && !multiTouch && travel < TAP_SLOP && event.timeStamp - press.startTime < TAP_MS;
      if (tap) actions.release();
    });
  canvas.addEventListener('pointerup', end, { signal });
  canvas.addEventListener('pointercancel', end, { signal });
  canvas.addEventListener(
    'wheel',
    (event) =>
      guard(() => {
        event.preventDefault();
        // Pixel and line deltas both map to a gentle exponential zoom.
        const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
        actions.zoom(Math.exp(Math.max(-60, Math.min(60, delta)) * 0.0022));
      }),
    { signal, passive: false },
  );
  canvas.addEventListener(
    'keydown',
    (event) =>
      guard(() => {
        if (event.altKey || event.ctrlKey || event.metaKey) return;
        // Held keys repeat; the one-shot actions fire once, but the repeats are still consumed
        // so a held Space does not scroll the page.
        switch (event.key) {
          case 'ArrowLeft':
            actions.orbit(KEY_RADIANS, 0);
            break;
          case 'ArrowRight':
            actions.orbit(-KEY_RADIANS, 0);
            break;
          case 'ArrowUp':
            actions.orbit(0, KEY_RADIANS * 0.6);
            break;
          case 'ArrowDown':
            actions.orbit(0, -KEY_RADIANS * 0.6);
            break;
          case '+':
          case '=':
            actions.zoom(1 / KEY_ZOOM);
            break;
          case '-':
          case '_':
            actions.zoom(KEY_ZOOM);
            break;
          case 'Enter':
            if (event.repeat) break;
            actions.release();
            break;
          case 'b':
          case 'B':
            if (event.repeat) break;
            actions.releaseBatch();
            break;
          case ' ':
            if (event.repeat) break;
            actions.togglePause();
            break;
          case '.':
            actions.step();
            break;
          case 'r':
          case 'R':
            if (event.repeat) break;
            actions.reset();
            break;
          case 'Home':
          case '0':
            actions.resetView();
            break;
          default:
            return;
        }
        event.preventDefault();
      }),
    { signal },
  );

  return {
    dispose() {
      controller.abort();
      for (const id of presses.keys()) {
        if (canvas.hasPointerCapture?.(id)) canvas.releasePointerCapture(id);
      }
      presses.clear();
    },
  };
}
