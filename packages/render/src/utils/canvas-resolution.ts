export interface CanvasResolution {
  readonly width: number;
  readonly height: number;
  dispose(): void;
}

export function canvasResolution(canvas: HTMLCanvasElement, opts?: { readonly observe?: boolean }): CanvasResolution {
  let width = canvas.width;
  let height = canvas.height;
  const update = (): void => {
    width = canvas.width;
    height = canvas.height;
  };
  const observer = opts?.observe === true ? new ResizeObserver(update) : undefined;
  observer?.observe(canvas);
  return Object.freeze({
    get width() { return width; },
    get height() { return height; },
    dispose: () => observer?.disconnect(),
  });
}
