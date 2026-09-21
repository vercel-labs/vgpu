import { expect, test } from "vitest";

import { installStirInput } from "./pointer-input";

class CanvasMock {
  style = { touchAction: "pan-y" };
  listeners = new Map<string, Set<(event: PointerEvent) => void>>();
  captured = new Set<number>();

  addEventListener(type: string, listener: EventListener) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener as never);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: EventListener) {
    this.listeners.get(type)?.delete(listener as never);
  }

  setPointerCapture(id: number) {
    this.captured.add(id);
  }

  hasPointerCapture(id: number) {
    return this.captured.has(id);
  }

  releasePointerCapture(id: number) {
    this.captured.delete(id);
  }

  getBoundingClientRect() {
    return { left: 0, top: 0, width: 100, height: 100 };
  }

  emit(type: string, event: Partial<PointerEvent>) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event as PointerEvent);
    }
  }
}

test("pointer movement is normalized, clamped, and decays for two solver steps", () => {
  const canvas = new CanvasMock();
  const input = installStirInput(canvas as unknown as HTMLCanvasElement);

  canvas.emit("pointermove", {
    pointerId: 1,
    isPrimary: true,
    clientX: 60,
    clientY: 40,
    timeStamp: 16,
  });
  expect(input.active).toBe(false);
  canvas.emit("pointermove", {
    pointerId: 1,
    isPrimary: true,
    clientX: 90,
    clientY: 10,
    timeStamp: 32,
  });
  expect(input.from).toEqual([0.6, 0.6]);
  expect(input.to).toEqual([0.9, 0.9]);
  expect(input.velocity).toEqual([2.5, 2.5]);
  expect(input.active).toBe(true);

  input.consumeStep();
  expect(input.velocity).toEqual([1.125, 1.125]);
  expect(input.active).toBe(true);
  input.consumeStep();
  expect(input.active).toBe(false);
  input.dispose();
});

test("disposing active stir input releases capture, listeners, and touch action", () => {
  const canvas = new CanvasMock();
  const input = installStirInput(canvas as unknown as HTMLCanvasElement);
  canvas.emit("pointerdown", {
    pointerId: 4,
    isPrimary: true,
    clientX: 10,
    clientY: 20,
    timeStamp: 1,
  });

  expect(canvas.captured.has(4)).toBe(true);
  input.dispose();
  expect(canvas.captured.size).toBe(0);
  expect(canvas.style.touchAction).toBe("pan-y");
  expect(
    [...canvas.listeners.values()].every((listeners) => listeners.size === 0)
  ).toBe(true);
});
