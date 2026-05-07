import { describe, expect, test, vi } from "vitest";
import { canvasMouseTracker } from "@vgpu/render/utils";

interface MockCanvas {
  width: number;
  height: number;
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
  getBoundingClientRect: () => { left: number; top: number; width: number; height: number };
}

function mockCanvas(): MockCanvas {
  return {
    width: 100,
    height: 60,
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

  test("dispose removes the same listener", () => {
    const canvas = mockCanvas();
    const tracker = canvasMouseTracker({ canvas: canvas as unknown as HTMLCanvasElement });
    tracker.dispose();
    expect(canvas.removeEventListener).toHaveBeenCalledWith("pointermove", canvas.addEventListener.mock.calls[0]?.[1]);
  });
});
