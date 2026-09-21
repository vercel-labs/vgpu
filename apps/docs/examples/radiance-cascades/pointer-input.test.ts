import { expect, test, vi } from "vitest";

import { installLightPaintInput } from "./pointer-input";

function setup() {
  const listeners = new Map<string, (event: PointerEvent) => void>();
  const captured = new Set<number>();
  const canvas = {
    style: { touchAction: "pan-y" },
    getBoundingClientRect: () => ({
      left: 10,
      top: 20,
      width: 100,
      height: 200,
    }),
    addEventListener: vi.fn(
      (name: string, listener: (event: PointerEvent) => void) => {
        listeners.set(name, listener);
      }
    ),
    removeEventListener: vi.fn((name: string) => listeners.delete(name)),
    setPointerCapture: vi.fn((id: number) => captured.add(id)),
    hasPointerCapture: vi.fn((id: number) => captured.has(id)),
    releasePointerCapture: vi.fn((id: number) => captured.delete(id)),
  } as unknown as HTMLCanvasElement;
  const fire = (
    name: string,
    values: Partial<PointerEvent> & { pointerId: number }
  ) => {
    listeners.get(name)?.({
      isPrimary: true,
      clientX: 60,
      clientY: 120,
      ...values,
    } as PointerEvent);
  };
  return { canvas, captured, fire, listeners };
}

test("paints clicks and coalesces a drag into one segment per frame", () => {
  const env = setup();
  const input = installLightPaintInput(env.canvas);
  expect(env.canvas.style.touchAction).toBe("none");
  expect(env.listeners.size).toBe(4);

  env.fire("pointermove", { pointerId: 1, clientX: 30, clientY: 40 });
  expect(input.take()).toBeUndefined();
  env.fire("pointerdown", { pointerId: 1 });
  expect(input.take()).toEqual({
    from: [0.5, 0.5],
    to: [0.5, 0.5],
    stroke: 1,
  });

  env.fire("pointermove", { pointerId: 1, clientX: 80, clientY: 80 });
  env.fire("pointermove", { pointerId: 1, clientX: 110, clientY: 220 });
  expect(input.take()).toEqual({
    from: [0.5, 0.5],
    to: [1, 1],
    stroke: 1,
  });
  env.fire("pointermove", { pointerId: 1, clientX: 10, clientY: 20 });
  expect(input.take()).toEqual({
    from: [1, 1],
    to: [0, 0],
    stroke: 1,
  });
});

test("ignores secondary pointers and starts a new palette stroke after release", () => {
  const env = setup();
  const input = installLightPaintInput(env.canvas);
  env.fire("pointerdown", { pointerId: 1, isPrimary: false });
  expect(input.take()).toBeUndefined();

  env.fire("pointerdown", { pointerId: 1 });
  input.take();
  env.fire("pointerdown", { pointerId: 2 });
  env.fire("pointermove", { pointerId: 2, clientX: 110, clientY: 220 });
  expect(input.take()).toBeUndefined();
  env.fire("pointerup", { pointerId: 1 });
  expect(env.canvas.releasePointerCapture).toHaveBeenCalledWith(1);

  env.fire("pointerdown", { pointerId: 2, clientX: 10, clientY: 20 });
  expect(input.take()).toEqual({ from: [0, 0], to: [0, 0], stroke: 2 });
});

test("dispose releases capture, removes listeners, and restores DOM state", () => {
  const env = setup();
  const input = installLightPaintInput(env.canvas);
  env.fire("pointerdown", { pointerId: 7 });
  input.dispose();

  expect(env.listeners.size).toBe(0);
  expect(env.captured.size).toBe(0);
  expect(env.canvas.style.touchAction).toBe("pan-y");
  expect(input.take()).toBeUndefined();
});

test("dispose restores DOM state when releasing capture throws", () => {
  const env = setup();
  const input = installLightPaintInput(env.canvas);
  env.fire("pointerdown", { pointerId: 7 });
  vi.mocked(env.canvas.releasePointerCapture).mockImplementation(() => {
    throw new Error("capture lost");
  });

  expect(() => input.dispose()).not.toThrow();
  expect(env.listeners.size).toBe(0);
  expect(env.canvas.style.touchAction).toBe("pan-y");
});
