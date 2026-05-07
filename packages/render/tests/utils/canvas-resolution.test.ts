import { afterEach, describe, expect, test, vi } from "vitest";
import { canvasResolution } from "@vgpu/render/utils";

interface MockCanvas { width: number; height: number }

let resizeCallback: ResizeObserverCallback | undefined;
let disconnect = vi.fn();

afterEach(() => {
  vi.unstubAllGlobals();
  disconnect = vi.fn();
  resizeCallback = undefined;
});

function installResizeObserver(): void {
  vi.stubGlobal("ResizeObserver", class {
    observe = vi.fn();
    disconnect = disconnect;
    constructor(callback: ResizeObserverCallback) { resizeCallback = callback; }
  });
}

describe("canvasResolution", () => {
  test("snapshots canvas size by default", () => {
    const canvas: MockCanvas = { width: 800, height: 600 };
    const resolution = canvasResolution(canvas as HTMLCanvasElement);
    canvas.width = 1024;
    expect(resolution.width).toBe(800);
    expect(resolution.height).toBe(600);
  });

  test("updates canvas size when observed", () => {
    installResizeObserver();
    const canvas: MockCanvas = { width: 800, height: 600 };
    const resolution = canvasResolution(canvas as HTMLCanvasElement, { observe: true });
    canvas.width = 1024;
    canvas.height = 768;
    resizeCallback?.([], {} as ResizeObserver);
    expect(resolution.width).toBe(1024);
    expect(resolution.height).toBe(768);
  });

  test("dispose disconnects observer", () => {
    installResizeObserver();
    const resolution = canvasResolution({ width: 800, height: 600 } as HTMLCanvasElement, { observe: true });
    resolution.dispose();
    expect(disconnect).toHaveBeenCalled();
  });
});
