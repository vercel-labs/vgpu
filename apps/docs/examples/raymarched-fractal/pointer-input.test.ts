import { expect, test, vi } from "vitest";

import type { Orbit } from "./pipeline";
import { createRenderScheduler, installDragOrbit } from "./pointer-input";

class CanvasMock {
  style = { touchAction: "pan-y" };
  listeners = new Map<string, Set<(event: PointerEvent) => void>>();
  captured = new Set<number>();
  addErrorType?: string;
  removeErrorType?: string;
  releaseError?: unknown;
  releaseErrorsBeforeClear: unknown[] = [];
  removeCalls: string[] = [];
  releaseCalls: number[] = [];

  addEventListener(type: string, listener: EventListener) {
    if (type === this.addErrorType) throw new Error(`add ${type} failed`);
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener as (event: PointerEvent) => void);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: EventListener) {
    this.removeCalls.push(type);
    this.listeners.get(type)?.delete(listener as (event: PointerEvent) => void);
    if (type === this.removeErrorType) throw new Error(`remove ${type} failed`);
  }

  setPointerCapture(id: number) {
    this.captured.add(id);
  }

  hasPointerCapture(id: number) {
    return this.captured.has(id);
  }

  releasePointerCapture(id: number) {
    this.releaseCalls.push(id);
    if (this.releaseErrorsBeforeClear.length) {
      throw this.releaseErrorsBeforeClear.shift();
    }
    this.captured.delete(id);
    if (this.releaseError !== undefined) throw this.releaseError;
  }

  emit(type: string, event: Partial<PointerEvent>) {
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      listener(event as PointerEvent);
    }
  }
}

const pointer = (
  pointerId: number,
  clientX: number,
  clientY: number,
  isPrimary = true
) => ({ pointerId, clientX, clientY, isPrimary });

const rethrow = (error: unknown): never => {
  throw error;
};

test("repeated drag maps yaw and pitch exactly and clamps both pitch extremes", () => {
  const canvas = new CanvasMock();
  const orbit: Orbit = { yaw: 0.58, pitch: 0.24 };
  const requestRender = vi.fn();
  const dispose = installDragOrbit(
    canvas as unknown as HTMLCanvasElement,
    orbit,
    requestRender,
    rethrow
  );

  canvas.emit("pointerdown", pointer(1, 10, 10));
  canvas.emit("pointermove", pointer(1, 10, 10));
  canvas.emit("pointermove", pointer(1, 30, -300));
  expect(orbit.yaw).toBeCloseTo(0.46);
  expect(orbit.pitch).toBe(-1.15);
  expect(requestRender).toHaveBeenCalledOnce();

  canvas.emit("pointermove", pointer(1, 30, 400));
  expect(orbit.pitch).toBe(1.15);
  expect(requestRender).toHaveBeenCalledTimes(2);
  dispose();
});

test("ignores hover, non-primary and secondary pointers, then stops on up or cancel", () => {
  const canvas = new CanvasMock();
  const orbit: Orbit = { yaw: 0.58, pitch: 0.24 };
  const requestRender = vi.fn();
  const dispose = installDragOrbit(
    canvas as unknown as HTMLCanvasElement,
    orbit,
    requestRender,
    rethrow
  );

  canvas.emit("pointermove", pointer(1, 50, 50));
  canvas.emit("pointerdown", pointer(9, 0, 0, false));
  canvas.emit("pointerdown", pointer(1, 10, 10));
  canvas.emit("pointerdown", pointer(2, 20, 20));
  canvas.emit("pointermove", pointer(2, 100, 100));
  expect(orbit).toEqual({ yaw: 0.58, pitch: 0.24 });
  expect(canvas.captured).toEqual(new Set([1]));

  canvas.emit("pointerup", pointer(1, 10, 10));
  canvas.emit("pointermove", pointer(1, 50, 50));
  canvas.emit("pointerdown", pointer(3, 0, 0));
  canvas.emit("pointercancel", pointer(3, 0, 0));
  expect(requestRender).not.toHaveBeenCalled();
  expect(canvas.captured.size).toBe(0);

  dispose();
  dispose();
  expect(canvas.style.touchAction).toBe("pan-y");
  expect(
    [...canvas.listeners.values()].every((listeners) => listeners.size === 0)
  ).toBe(true);
});

test("pointer callback failure is reported with exact identity and remains disposable", () => {
  const canvas = new CanvasMock();
  const orbit: Orbit = { yaw: 0.58, pitch: 0.24 };
  const primary = new Error("capture failed");
  canvas.setPointerCapture = () => {
    throw primary;
  };
  const onError = vi.fn((error: unknown): never => {
    throw error;
  });
  const dispose = installDragOrbit(
    canvas as unknown as HTMLCanvasElement,
    orbit,
    vi.fn(),
    onError
  );

  expect(() => canvas.emit("pointerdown", pointer(1, 0, 0))).toThrow(primary);
  expect(onError).toHaveBeenCalledWith(primary);
  dispose();
  expect(canvas.style.touchAction).toBe("pan-y");
  expect(
    [...canvas.listeners.values()].every((listeners) => listeners.size === 0)
  ).toBe(true);
});

test("failed pointer release retains its id so synchronous teardown can retry", () => {
  const canvas = new CanvasMock();
  const orbit: Orbit = { yaw: 0.58, pitch: 0.24 };
  const primary = new Error("release failed before clearing capture");
  canvas.releaseErrorsBeforeClear.push(primary);
  let dispose = () => {};
  const onError = (error: unknown): never => {
    try {
      dispose();
    } catch {
      // The callback failure remains primary.
    }
    throw error;
  };
  dispose = installDragOrbit(
    canvas as unknown as HTMLCanvasElement,
    orbit,
    vi.fn(),
    onError
  );

  canvas.emit("pointerdown", pointer(5, 0, 0));
  expect(() => canvas.emit("pointerup", pointer(5, 0, 0))).toThrow(primary);
  expect(canvas.releaseCalls).toEqual([5, 5]);
  expect(canvas.captured.size).toBe(0);
  expect(canvas.style.touchAction).toBe("pan-y");
  expect(
    [...canvas.listeners.values()].every((listeners) => listeners.size === 0)
  ).toBe(true);
});

test("partial listener installation rolls back listeners and touch style", () => {
  const canvas = new CanvasMock();
  canvas.addErrorType = "pointerup";
  const orbit: Orbit = { yaw: 0.58, pitch: 0.24 };

  expect(() =>
    installDragOrbit(
      canvas as unknown as HTMLCanvasElement,
      orbit,
      vi.fn(),
      rethrow
    )
  ).toThrow("add pointerup failed");
  expect(canvas.style.touchAction).toBe("pan-y");
  expect(
    [...canvas.listeners.values()].every((listeners) => listeners.size === 0)
  ).toBe(true);
});

test("dispose attempts every cleanup and reports its first failure", () => {
  const canvas = new CanvasMock();
  const orbit: Orbit = { yaw: 0.58, pitch: 0.24 };
  const dispose = installDragOrbit(
    canvas as unknown as HTMLCanvasElement,
    orbit,
    vi.fn(),
    rethrow
  );
  canvas.emit("pointerdown", pointer(7, 0, 0));
  canvas.removeErrorType = "pointerdown";
  canvas.releaseError = new Error("release failed");

  expect(dispose).toThrow("remove pointerdown failed");
  expect(canvas.removeCalls).toEqual([
    "pointerdown",
    "pointermove",
    "pointerup",
    "pointercancel",
  ]);
  expect(canvas.captured.size).toBe(0);
  expect(canvas.style.touchAction).toBe("pan-y");
});

test("render scheduler coalesces demand, survives render errors, and cancels disposal", () => {
  const callbacks = new Map<number, FrameRequestCallback>();
  let next = 0;
  const primary = new Error("render failed");
  const render = vi.fn(() => {
    if (render.mock.calls.length === 1) throw primary;
  });
  const scheduler = createRenderScheduler(
    render,
    (callback) => {
      callbacks.set(++next, callback);
      return next;
    },
    (id) => callbacks.delete(id)
  );

  scheduler.request();
  scheduler.request();
  expect(callbacks.size).toBe(1);
  const first = callbacks.get(1)!;
  callbacks.delete(1);
  expect(() => first(0)).toThrow(primary);
  scheduler.request();
  expect(callbacks.size).toBe(1);
  const second = callbacks.get(2)!;
  callbacks.delete(2);
  second(0);
  expect(render).toHaveBeenCalledTimes(2);

  scheduler.request();
  scheduler.dispose();
  scheduler.dispose();
  scheduler.request();
  expect(callbacks.size).toBe(0);
});

test("synchronous RAF failure leaves scheduler retryable", () => {
  const primary = new Error("RAF failed");
  const callback = vi.fn();
  const raf = vi
    .fn<(callback: FrameRequestCallback) => number>()
    .mockImplementationOnce(() => {
      throw primary;
    })
    .mockImplementationOnce(() => 4);
  const scheduler = createRenderScheduler(callback, raf, vi.fn());

  expect(() => scheduler.request()).toThrow(primary);
  expect(() => scheduler.request()).not.toThrow();
  expect(raf).toHaveBeenCalledTimes(2);
});
