import { expect, test } from "vitest";

import { installShapeInput, normalizePointer } from "./pointer-input";

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
  getBoundingClientRect() {
    return { left: 10, top: 20, width: 200, height: 100 };
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
  emit(type: string, event: Partial<PointerEvent>) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event as PointerEvent);
    }
  }
}

test("normalizes and clamps pointer coordinates around the canvas center", () => {
  const rect = { left: 10, top: 20, width: 200, height: 100 };
  expect(normalizePointer(110, 70, rect)).toEqual([0, 0]);
  expect(normalizePointer(-100, 200, rect)).toEqual([-1, -1]);
});

test("eases hover deformation and restores listeners and touch behavior", () => {
  const canvas = new CanvasMock();
  const input = installShapeInput(canvas as unknown as HTMLCanvasElement);
  canvas.emit("pointerenter", {
    isPrimary: true,
    pointerId: 1,
    clientX: 210,
    clientY: 20,
  });
  input.update();
  expect(input.position[0]).toBeCloseTo(0.11);
  expect(input.position[1]).toBeCloseTo(0.11);
  expect(input.strength).toBeCloseTo(0.13);

  canvas.emit("pointerdown", {
    isPrimary: true,
    pointerId: 3,
    clientX: 110,
    clientY: 70,
  });
  expect(canvas.captured.has(3)).toBe(true);
  input.dispose();
  expect(canvas.captured.size).toBe(0);
  expect(canvas.style.touchAction).toBe("pan-y");
  expect(
    [...canvas.listeners.values()].every((listeners) => listeners.size === 0)
  ).toBe(true);
});
