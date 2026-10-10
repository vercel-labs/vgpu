/** Orbit input on the canvas: drag to orbit, wheel or pinch to zoom, arrows and +/- when focused. */
export interface OrbitHandlers {
  orbit(deltaYaw: number, deltaPitch: number): void;
  /** Multiplies the camera distance; < 1 moves closer. */
  zoom(factor: number): void;
}

export interface OrbitInput {
  /** True while a pointer is held on the canvas. */
  readonly dragging: boolean;
  dispose(): void;
}

const DRAG_RADIANS_PER_PIXEL = 0.006;
const KEY_RADIANS = 0.12;
const KEY_ZOOM = 1.12;

export function installOrbitInput(
  canvas: HTMLCanvasElement,
  handlers: OrbitHandlers,
  guard: (action: () => void) => void = (action) => action(),
): OrbitInput {
  const pointers = new Map<number, { x: number; y: number }>();
  let pinchDistance = 0;
  const controller = new AbortController();
  const { signal } = controller;

  const spread = () => {
    const [a, b] = [...pointers.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  };

  canvas.addEventListener(
    'pointerdown',
    (event) =>
      guard(() => {
        // Only the primary mouse button orbits; touch and pen contacts all count.
        if (pointers.size >= 2 || (event.pointerType === 'mouse' && event.button !== 0)) return;
        pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
        canvas.setPointerCapture?.(event.pointerId);
        pinchDistance = spread();
      }),
    { signal },
  );
  canvas.addEventListener(
    'pointermove',
    (event) =>
      guard(() => {
        const last = pointers.get(event.pointerId);
        if (!last) return;
        const dx = event.clientX - last.x;
        const dy = event.clientY - last.y;
        last.x = event.clientX;
        last.y = event.clientY;
        if (pointers.size === 2) {
          const distance = spread();
          if (pinchDistance > 0 && distance > 0) handlers.zoom(pinchDistance / distance);
          pinchDistance = distance;
          return;
        }
        handlers.orbit(-dx * DRAG_RADIANS_PER_PIXEL, dy * DRAG_RADIANS_PER_PIXEL);
      }),
    { signal },
  );
  const end = (event: PointerEvent) =>
    guard(() => {
      if (!pointers.delete(event.pointerId)) return;
      if (canvas.hasPointerCapture?.(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
      pinchDistance = spread();
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
        handlers.zoom(Math.exp(Math.max(-60, Math.min(60, delta)) * 0.0022));
      }),
    { signal, passive: false },
  );
  canvas.addEventListener(
    'keydown',
    (event) =>
      guard(() => {
        if (event.altKey || event.ctrlKey || event.metaKey) return;
        switch (event.key) {
          case 'ArrowLeft':
            handlers.orbit(KEY_RADIANS, 0);
            break;
          case 'ArrowRight':
            handlers.orbit(-KEY_RADIANS, 0);
            break;
          case 'ArrowUp':
            handlers.orbit(0, KEY_RADIANS * 0.6);
            break;
          case 'ArrowDown':
            handlers.orbit(0, -KEY_RADIANS * 0.6);
            break;
          case '+':
          case '=':
            handlers.zoom(1 / KEY_ZOOM);
            break;
          case '-':
          case '_':
            handlers.zoom(KEY_ZOOM);
            break;
          default:
            return;
        }
        event.preventDefault();
      }),
    { signal },
  );

  return {
    get dragging() {
      return pointers.size > 0;
    },
    dispose() {
      controller.abort();
      for (const id of pointers.keys()) {
        if (canvas.hasPointerCapture?.(id)) canvas.releasePointerCapture(id);
      }
      pointers.clear();
    },
  };
}
