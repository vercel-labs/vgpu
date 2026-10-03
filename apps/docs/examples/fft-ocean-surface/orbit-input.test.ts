import { expect, test, vi } from "vitest";
import { orbitRig } from "vgpu/scene";
import { installOrbitInput } from "./orbit-input";

function fakeElement() {
  const listeners = new Map<string, EventListener>();
  const element = {
    addEventListener: vi.fn((type: string, listener: EventListener) => listeners.set(type, listener)),
    removeEventListener: vi.fn((type: string) => listeners.delete(type)),
    setPointerCapture: vi.fn(),
    releasePointerCapture: vi.fn(),
  };
  return {
    element,
    emit(type: string, event: Record<string, unknown>) {
      listeners.get(type)?.(event as unknown as Event);
    },
  };
}

test("pointer and wheel input mutate only the app-owned goal rig", () => {
  const fake = fakeElement();
  const goal = orbitRig({ yaw: 0.25, pitch: 0.4, distance: 128 });
  const input = installOrbitInput(fake.element, goal);

  fake.emit("pointerdown", { pointerId: 7, button: 0, clientX: 10, clientY: 20 });
  fake.emit("pointermove", { pointerId: 7, clientX: 30, clientY: 50 });
  fake.emit("wheel", { deltaY: 100, preventDefault: vi.fn() });

  expect(goal.yaw).toBeCloseTo(0.15);
  expect(goal.pitch).toBeCloseTo(0.55);
  expect(goal.distance).toBeCloseTo(128 * Math.exp(0.1));
  expect(fake.element.setPointerCapture).toHaveBeenCalledWith(7);

  input.dispose();
  expect(fake.element.removeEventListener).toHaveBeenCalledTimes(5);
});

test("input clamps authored pitch and distance limits and disposal is idempotent", () => {
  const fake = fakeElement();
  const goal = orbitRig({ pitch: 1.3, distance: 690 });
  const input = installOrbitInput(fake.element, goal);

  fake.emit("pointerdown", { pointerId: 2, button: 0, clientX: 0, clientY: 0 });
  fake.emit("pointermove", { pointerId: 2, clientX: 0, clientY: 100 });
  fake.emit("wheel", { deltaY: 1000, preventDefault: vi.fn() });

  expect(goal.pitch).toBe(1.35);
  expect(goal.distance).toBe(700);
  input.dispose();
  input.dispose();
  expect(fake.element.removeEventListener).toHaveBeenCalledTimes(5);
});

test("non-primary pointer buttons do not begin an orbit", () => {
  const fake = fakeElement();
  const goal = orbitRig({ yaw: 0.25, pitch: 0.4, distance: 128 });
  const input = installOrbitInput(fake.element, goal);

  fake.emit("pointerdown", { pointerId: 7, button: 2, clientX: 10, clientY: 20 });
  fake.emit("pointermove", { pointerId: 7, clientX: 30, clientY: 50 });

  expect(goal.yaw).toBe(0.25);
  expect(goal.pitch).toBe(0.4);
  expect(fake.element.setPointerCapture).not.toHaveBeenCalled();
  input.dispose();
});

test("listener installation rolls back earlier listeners on failure", () => {
  const primary = new Error("wheel listener");
  const element = {
    addEventListener: vi.fn((type: string) => {
      if (type === "wheel") throw primary;
    }),
    removeEventListener: vi.fn(),
  };

  expect(() => installOrbitInput(element, orbitRig())).toThrow(primary);
  expect(element.removeEventListener.mock.calls.map(([type]) => type)).toEqual([
    "pointercancel",
    "pointerup",
    "pointermove",
    "pointerdown",
  ]);
});
