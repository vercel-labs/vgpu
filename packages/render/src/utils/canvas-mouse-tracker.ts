export interface CanvasMouseTrackerSpec {
  readonly canvas: HTMLCanvasElement;
  readonly flipY?: boolean;
}

export interface CanvasMousePosition {
  readonly normalized: readonly [number, number];
  readonly canvasPixels: readonly [number, number];
}

export interface CanvasMouseTracker {
  readonly position: CanvasMousePosition;
  dispose(): void;
}

export function canvasMouseTracker(spec: CanvasMouseTrackerSpec): CanvasMouseTracker {
  let position: CanvasMousePosition = Object.freeze({
    normalized: Object.freeze([0, 0] as const),
    canvasPixels: Object.freeze([0, 0] as const),
  });
  const handler = (event: PointerEvent): void => {
    const rect = spec.canvas.getBoundingClientRect();
    const hasOffsetX = Number.isFinite(event.offsetX);
    const hasOffsetY = Number.isFinite(event.offsetY);
    // Offset coordinates ignore transforms and start at the padding edge, so pair them with
    // client dimensions. Viewport coordinates instead use the transformed bounding rectangle.
    const cssWidth = (hasOffsetX ? spec.canvas.clientWidth : rect.width) || rect.width;
    const cssHeight = (hasOffsetY ? spec.canvas.clientHeight : rect.height) || rect.height;
    const width = spec.canvas.width || cssWidth || 1;
    const height = spec.canvas.height || cssHeight || 1;
    const normalizedX = (hasOffsetX ? event.offsetX : event.clientX - rect.left) / (cssWidth || width);
    const normalizedY = (hasOffsetY ? event.offsetY : event.clientY - rect.top) / (cssHeight || height);
    const y = spec.flipY === true ? 1 - normalizedY : normalizedY;
    position = Object.freeze({
      normalized: Object.freeze([normalizedX, y] as const),
      canvasPixels: Object.freeze([normalizedX * width, y * height] as const),
    });
  };
  spec.canvas.addEventListener("pointermove", handler);
  return Object.freeze({
    get position() { return position; },
    dispose: () => spec.canvas.removeEventListener("pointermove", handler),
  });
}
