import { describe, expect, test, vi } from "vitest";
import { canvasMouseTracker } from "@vgpu/render/utils";

interface MockCanvas {
  width: number;
  height: number;
  clientWidth: number;
  clientHeight: number;
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
  getBoundingClientRect: () => { left: number; top: number; width: number; height: number };
}

interface MockCanvasOptions {
  readonly bufferSize?: readonly [number, number];
  readonly clientSize?: readonly [number, number];
  readonly rect?: { readonly left: number; readonly top: number; readonly width: number; readonly height: number };
}

function mockCanvas(options: MockCanvasOptions = {}): MockCanvas {
  const [width, height] = options.bufferSize ?? [100, 60];
  const [clientWidth, clientHeight] = options.clientSize ?? [100, 60];
  const rect = options.rect ?? { left: 0, top: 0, width: clientWidth, height: clientHeight };
  return {
    width,
    height,
    clientWidth,
    clientHeight,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    getBoundingClientRect: () => rect,
  };
}

function move(
  canvas: MockCanvas,
  offsetX: number,
  offsetY: number,
  clientX = offsetX,
  clientY = offsetY,
): void {
  const handler = canvas.addEventListener.mock.calls[0]?.[1] as (event: PointerEvent) => void;
  handler({ offsetX, offsetY, clientX, clientY } as PointerEvent);
}

function expectPosition(
  tracker: ReturnType<typeof canvasMouseTracker>,
  normalized: readonly [number, number],
  canvasPixels: readonly [number, number],
): void {
  expect(tracker.position).toEqual({ normalized, canvasPixels });
}

describe("canvasMouseTracker", () => {
  test("starts with frozen zero coordinates", () => {
    const canvas = mockCanvas();
    const tracker = canvasMouseTracker({ canvas: canvas as unknown as HTMLCanvasElement });
    expectPosition(tracker, [0, 0], [0, 0]);
    expect(Object.isFrozen(tracker.position)).toBe(true);
    expect(Object.isFrozen(tracker.position.normalized)).toBe(true);
    expect(Object.isFrozen(tracker.position.canvasPixels)).toBe(true);
  });

  test("tracks normalized and canvas-pixel positions", () => {
    const canvas = mockCanvas();
    const tracker = canvasMouseTracker({ canvas: canvas as unknown as HTMLCanvasElement });
    move(canvas, 50, 30);
    expectPosition(tracker, [0.5, 0.5], [50, 30]);
  });

  test("flips y in both coordinate spaces", () => {
    const canvas = mockCanvas();
    const tracker = canvasMouseTracker({ canvas: canvas as unknown as HTMLCanvasElement, flipY: true });
    move(canvas, 50, 15);
    expectPosition(tracker, [0.5, 0.75], [50, 45]);
  });

  test("scales canvas pixels independently of normalized coordinates", () => {
    const canvas = mockCanvas({ bufferSize: [200, 120] });
    const tracker = canvasMouseTracker({ canvas: canvas as unknown as HTMLCanvasElement });
    move(canvas, 50, 30);
    expectPosition(tracker, [0.5, 0.5], [100, 60]);
  });

  test("uses untransformed layout dimensions with offset coordinates", () => {
    const canvas = mockCanvas({
      bufferSize: [200, 120],
      rect: { left: 0, top: 0, width: 200, height: 120 },
    });
    const tracker = canvasMouseTracker({ canvas: canvas as unknown as HTMLCanvasElement });
    move(canvas, 50, 30);
    expectPosition(tracker, [0.5, 0.5], [100, 60]);
  });

  test("does not include borders when scaling offset coordinates", () => {
    const canvas = mockCanvas({
      bufferSize: [200, 120],
      rect: { left: 0, top: 0, width: 104, height: 64 },
    });
    const tracker = canvasMouseTracker({ canvas: canvas as unknown as HTMLCanvasElement });
    move(canvas, 50, 30);
    expectPosition(tracker, [0.5, 0.5], [100, 60]);
  });

  test("falls back to viewport coordinates and bounds", () => {
    const canvas = mockCanvas({
      bufferSize: [200, 120],
      rect: { left: 10, top: 20, width: 200, height: 120 },
    });
    const tracker = canvasMouseTracker({ canvas: canvas as unknown as HTMLCanvasElement });
    move(canvas, Number.NaN, Number.NaN, 110, 80);
    expectPosition(tracker, [0.5, 0.5], [100, 60]);
  });

  test("preserves pixel coordinates when layout bounds are unavailable", () => {
    const canvas = mockCanvas({
      clientSize: [0, 0],
      rect: { left: 0, top: 0, width: 0, height: 0 },
    });
    const tracker = canvasMouseTracker({ canvas: canvas as unknown as HTMLCanvasElement });
    move(canvas, 50, 30);
    expectPosition(tracker, [0.5, 0.5], [50, 30]);
  });

  test("dispose removes the same listener", () => {
    const canvas = mockCanvas();
    const tracker = canvasMouseTracker({ canvas: canvas as unknown as HTMLCanvasElement });
    tracker.dispose();
    expect(canvas.removeEventListener).toHaveBeenCalledWith("pointermove", canvas.addEventListener.mock.calls[0]?.[1]);
  });
});
