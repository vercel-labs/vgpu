import { describe, expect, test, vi } from "vitest";
import { canvasMouseTracker } from "@vgpu/render/utils";

interface MockCanvas {
  width: number;
  height: number;
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
  getBoundingClientRect: () => { left: number; top: number; width: number; height: number };
}

function mockCanvas(dpr = 1): MockCanvas {
  return {
    // The drawing buffer is CSS size x dpr, which is how `surface()` sizes a canvas.
    width: 100 * dpr,
    height: 60 * dpr,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 60 }),
  };
}

function move(canvas: MockCanvas, offsetX: number, offsetY: number): void {
  const handler = canvas.addEventListener.mock.calls[0]?.[1] as (event: PointerEvent) => void;
  handler({ offsetX, offsetY, clientX: offsetX, clientY: offsetY } as PointerEvent);
}

describe("canvasMouseTracker", () => {
  test("tracks pixel position by default", () => {
    const canvas = mockCanvas();
    const tracker = canvasMouseTracker({ canvas: canvas as unknown as HTMLCanvasElement });
    move(canvas, 50, 30);
    expect(tracker.position).toEqual([50, 30]);
  });

  test("tracks normalized position", () => {
    const canvas = mockCanvas();
    const tracker = canvasMouseTracker({ canvas: canvas as unknown as HTMLCanvasElement, normalize: true });
    move(canvas, 50, 30);
    expect(tracker.position).toEqual([0.5, 0.5]);
  });

  test("flips normalized y", () => {
    const canvas = mockCanvas();
    const tracker = canvasMouseTracker({ canvas: canvas as unknown as HTMLCanvasElement, normalize: true, flipY: true });
    move(canvas, 50, 15);
    expect(tracker.position).toEqual([0.5, 0.75]);
  });

  // `offsetX/offsetY` are CSS pixels; `canvas.width/height` are drawing-buffer pixels.
  // At dpr !== 1 the two differ, so the reported position has to be scaled into buffer space.
  test("reports buffer pixels, not CSS pixels, at dpr 2", () => {
    const canvas = mockCanvas(2);
    const tracker = canvasMouseTracker({ canvas: canvas as unknown as HTMLCanvasElement });
    move(canvas, 100, 60); // bottom-right corner, in CSS pixels
    expect(tracker.position).toEqual([200, 120]);
  });

  test("normalizes against the CSS box at dpr 2", () => {
    const canvas = mockCanvas(2);
    const tracker = canvasMouseTracker({ canvas: canvas as unknown as HTMLCanvasElement, normalize: true });
    move(canvas, 100, 60);
    expect(tracker.position).toEqual([1, 1]);
  });

  test("flips y within the buffer at dpr 2", () => {
    const canvas = mockCanvas(2);
    const tracker = canvasMouseTracker({ canvas: canvas as unknown as HTMLCanvasElement, flipY: true });
    move(canvas, 100, 60); // bottom edge -> flipped y is 0, not `bufferHeight - cssY`
    expect(tracker.position).toEqual([200, 0]);
  });

  test("dispose removes the same listener", () => {
    const canvas = mockCanvas();
    const tracker = canvasMouseTracker({ canvas: canvas as unknown as HTMLCanvasElement });
    tracker.dispose();
    expect(canvas.removeEventListener).toHaveBeenCalledWith("pointermove", canvas.addEventListener.mock.calls[0]?.[1]);
  });
});