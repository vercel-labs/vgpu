import { expect, test, vi } from "vitest";

import { MAX_RADIUS, MIN_RADIUS } from "./camera";
import { installOrbitInput } from "./pointer-input";

function setup() {
  const listeners = new Map<string, EventListener>();
  const captured = new Set<number>();
  const canvas = {
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

test("orbits the primary pointer with easing and pitch limits", () => {
  const env = setup();
  const input = installOrbitInput(env.canvas, { yaw: 1, pitch: 0.4 });
  env.pointer("pointerdown");
  env.pointer("pointermove", { clientX: 120, clientY: 1000 });
  input.advance(0.1);

  const blend = 1 - Math.exp(-1.4);
  expect(input.yaw).toBeCloseTo(1 - 20 * 0.006 * blend);
  expect(input.pitch).toBeCloseTo(0.4 + (1.05 - 0.4) * blend);
  expect(env.captured.has(1)).toBe(true);

  env.pointer("pointermove", {
    clientX: 500,
    isPrimary: false,
    pointerId: 2,
  });
  const yaw = input.yaw;
  input.advance(0.1);
  expect(input.yaw).toBeLessThan(yaw);
});

test("prevents wheel scrolling and clamps the orbit radius", () => {
  const env = setup();
  const input = installOrbitInput(env.canvas, { radius: 100 });
  expect(input.radius).toBe(MAX_RADIUS);

  expect(env.wheel(-100_000)).toHaveBeenCalledTimes(1);
  for (let index = 0; index < 30; index++) input.advance(0.1);
  expect(input.radius).toBeCloseTo(MIN_RADIUS);

  env.wheel(100_000);
  for (let index = 0; index < 30; index++) input.advance(0.1);
  expect(input.radius).toBeCloseTo(MAX_RADIUS);
});

test("dispose removes DOM state and releases an active capture", () => {
  const env = setup();
  const input = installOrbitInput(env.canvas);
  env.pointer("pointerdown", { pointerId: 7 });
  input.dispose();

  expect(env.listeners.size).toBe(0);
  expect(env.captured.size).toBe(0);
  expect(env.canvas.style.touchAction).toBe("pan-y");
});

test("restores DOM state even when capture release fails", () => {
  const env = setup();
  const input = installOrbitInput(env.canvas);
  env.pointer("pointerdown", { pointerId: 7 });
  const failure = new Error("capture lost");
  vi.mocked(env.canvas.releasePointerCapture).mockImplementation(() => {
    throw failure;
  });

  expect(() => input.dispose()).toThrow(failure);
  expect(env.listeners.size).toBe(0);
  expect(env.canvas.style.touchAction).toBe("pan-y");
});
