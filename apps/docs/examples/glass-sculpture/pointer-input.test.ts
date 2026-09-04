import { expect, test, vi } from "vitest";

import { MAX_PITCH, MAX_RADIUS, MIN_RADIUS } from "./camera";
import { installPointerInput } from "./pointer-input";

function setup() {
  const listeners = new Map<string, EventListener>();
  const captured = new Set<number>();
  const canvas = {
    clientWidth: 400,
    clientHeight: 200,
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
    style: { touchAction: "pan-y" },
    addEventListener: vi.fn((name: string, listener: EventListener) => {
      listeners.set(name, listener);
    }),
    removeEventListener: vi.fn((name: string) => listeners.delete(name)),
    setPointerCapture: vi.fn((id: number) => captured.add(id)),
    hasPointerCapture: vi.fn((id: number) => captured.has(id)),
    releasePointerCapture: vi.fn((id: number) => captured.delete(id)),
  } as unknown as HTMLCanvasElement;
  const pointer = (name: string, values: Partial<PointerEvent> = {}) => {
    listeners.get(name)?.({
      clientX: 100,
      clientY: 100,
      isPrimary: true,
      pointerId: 1,
      ...values,
    } as PointerEvent);
  };
  const wheel = (deltaY: number) => {
    const preventDefault = vi.fn();
    listeners.get("wheel")?.({ deltaY, preventDefault } as unknown as Event);
    return preventDefault;
  };
  return { canvas, captured, listeners, pointer, wheel };
}

test("dragging orbits the camera with easing and pitch limits", () => {
  const env = setup();
  const input = installPointerInput(env.canvas, { yaw: 1, pitch: 0.4 });
  env.pointer("pointerdown");
  env.pointer("pointermove", { clientX: 120, clientY: 1000 });
  input.advance(0.1);

  const blend = 1 - Math.exp(-1.4);
  expect(input.yaw).toBeCloseTo(1 + 20 * 0.006 * blend);
  expect(input.pitch).toBeCloseTo(0.4 + (MAX_PITCH - 0.4) * blend);
  expect(env.captured.has(1)).toBe(true);

  // A second, non-primary pointer never steals the drag.
  env.pointer("pointermove", { clientX: 500, isPrimary: false, pointerId: 2 });
  const yaw = input.yaw;
  input.advance(0.1);
  expect(input.yaw).toBeGreaterThan(yaw);

  env.pointer("pointerup");
  expect(env.captured.has(1)).toBe(false);
});

test("hovering steers the key light, and it returns to the sweep once the pointer rests", () => {
  const env = setup();
  const input = installPointerInput(env.canvas);
  // Pointer at the right edge, top of the canvas: light swings right and up.
  env.pointer("pointermove", { clientX: 400, clientY: 0 });
  expect(input.hovering).toBe(true);
  for (let i = 0; i < 40; i++) input.advance(0.05);
  expect(input.lightAzimuth).toBeCloseTo(1.8, 1);
  expect(input.lightElevation).toBeCloseTo(1.15, 1);

  // After the hold time the automatic sweep takes over again.
  for (let i = 0; i < 60; i++) input.advance(0.1);
  expect(input.hovering).toBe(false);
  const before = input.lightAzimuth;
  for (let i = 0; i < 20; i++) input.advance(0.1);
  expect(input.lightAzimuth).not.toBeCloseTo(before, 3);
});

test("prevents wheel scrolling and clamps the orbit radius", () => {
  const env = setup();
  const input = installPointerInput(env.canvas, { radius: 100 });
  expect(input.radius).toBe(MAX_RADIUS);
  expect(env.wheel(-100_000)).toHaveBeenCalledTimes(1);
  for (let i = 0; i < 50; i++) input.advance(0.1);
  expect(input.radius).toBeCloseTo(MIN_RADIUS, 3);
});

test("dispose removes listeners, releases capture and restores touch-action", () => {
  const env = setup();
  const input = installPointerInput(env.canvas);
  env.pointer("pointerdown");
  input.dispose();

  expect(env.listeners.size).toBe(0);
  expect(env.captured.size).toBe(0);
  expect(env.canvas.style.touchAction).toBe("pan-y");
});
