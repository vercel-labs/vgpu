export interface CanvasMouseTrackerSpec {
  readonly canvas: HTMLCanvasElement;
  readonly normalize?: boolean;
  readonly flipY?: boolean;
}

export interface CanvasMouseTracker {
  readonly position: readonly [number, number];
  dispose(): void;
}

export function canvasMouseTracker(spec: CanvasMouseTrackerSpec): CanvasMouseTracker {
  let position: readonly [number, number] = Object.freeze([0, 0] as const);
  const handler = (event: PointerEvent): void => {
    const rect = spec.canvas.getBoundingClientRect();
    const rawX = Number.isFinite(event.offsetX) ? event.offsetX : event.clientX - rect.left;
    const rawY = Number.isFinite(event.offsetY) ? event.offsetY : event.clientY - rect.top;
    const width = spec.canvas.width || rect.width || 1;
    const height = spec.canvas.height || rect.height || 1;
    const x = spec.normalize === true ? rawX / width : rawX;
    const y = spec.normalize === true ? rawY / height : rawY;
    position = Object.freeze([x, spec.flipY === true ? (spec.normalize === true ? 1 - y : height - y) : y] as const);
  };
  spec.canvas.addEventListener("pointermove", handler);
  return Object.freeze({
    get position() { return position; },
    dispose: () => spec.canvas.removeEventListener("pointermove", handler),
  });
}
