import { describe, expect, it, vi } from "vitest";
import { orbitRig } from "vgpu/scene";

import { installOrbitInput, ORBIT_LIMITS, panGround } from "./orbit-input";
import { HOME_VIEW } from "./pipeline";

interface PointerInit {
  readonly id?: number;
  readonly type?: string;
  readonly button?: number;
  readonly shift?: boolean;
  readonly time?: number;
}

function setup() {
  const listeners = new Map<string, { listener: EventListener; options?: AddEventListenerOptions }>();
  const captured = new Set<number>();
  const element = {
    addEventListener: vi.fn((type: string, listener: EventListener, options?: AddEventListenerOptions) => {
      listeners.set(type, { listener, options });
    }),
    removeEventListener: vi.fn((type: string) => listeners.delete(type)),
    setPointerCapture: vi.fn((id: number) => captured.add(id)),
    releasePointerCapture: vi.fn((id: number) => {
      // Like the DOM: releasing a pointer that is not captured throws NotFoundError.
      if (!captured.delete(id)) throw new Error("NotFoundError");
    }),
    hasPointerCapture: vi.fn((id: number) => captured.has(id)),
  };
  const goal = orbitRig(HOME_VIEW);
  const onTap = vi.fn();
  const input = installOrbitInput(element, goal, { onTap });
  const dispatch = (type: string, values: Record<string, unknown>) => {
    const event = { type, preventDefault: vi.fn(), ...values } as unknown as Event;
    listeners.get(type)?.listener(event);
    return event as Event & { preventDefault: ReturnType<typeof vi.fn> };
  };
  const pointer = (type: string, x: number, y: number, init: PointerInit = {}) =>
    dispatch(type, {
      pointerId: init.id ?? 1,
      pointerType: init.type ?? "mouse",
      button: init.button ?? 0,
      shiftKey: init.shift ?? false,
      clientX: x,
      clientY: y,
      timeStamp: init.time ?? 0,
    });
  return { listeners, captured, goal, onTap, input, dispatch, pointer };
}

describe("modular-city orbit input", () => {
  it("orbits on a mouse drag within the pitch limits and reports no tap", () => {
    const { goal, onTap, pointer, input, captured } = setup();
    pointer("pointerenter", 100, 100);
    expect(input.engaged).toBe(true);
    pointer("pointerdown", 100, 100);
    expect(captured.has(1)).toBe(true);
    pointer("pointermove", 140, 130, { time: 16 });
    expect(goal.yaw).toBeCloseTo(HOME_VIEW.yaw - 40 * 0.005, 6);
    expect(goal.pitch).toBeCloseTo(HOME_VIEW.pitch + 30 * 0.004, 6);
    pointer("pointermove", 140, 5000, { time: 32 });
    expect(goal.pitch).toBe(ORBIT_LIMITS.maxPitch);
    pointer("pointerup", 140, 5000, { time: 48 });
    expect(onTap).not.toHaveBeenCalled();
    expect(captured.size).toBe(0);
    pointer("pointerleave", 140, 5000);
    expect(input.engaged).toBe(false);
  });

  it("reports a short, still click as a tap and ignores long presses and cancels", () => {
    const { onTap, pointer } = setup();
    pointer("pointerdown", 50, 60, { time: 1000 });
    pointer("pointerup", 52, 61, { time: 1120 });
    expect(onTap).toHaveBeenCalledExactlyOnceWith({ clientX: 52, clientY: 61, pointerType: "mouse" });

    pointer("pointerdown", 50, 60, { time: 2000 });
    pointer("pointerup", 50, 60, { time: 2600 });
    pointer("pointerdown", 50, 60, { time: 3000 });
    pointer("pointercancel", 50, 60, { time: 3050 });
    pointer("pointerdown", 50, 60, { button: 1, time: 4000 });
    pointer("pointerup", 50, 60, { button: 1, time: 4050 });
    expect(onTap).toHaveBeenCalledOnce();
  });

  it("pans on right or shift drag and zooms on the wheel within the distance limits", () => {
    const { goal, onTap, pointer, dispatch, listeners } = setup();
    pointer("pointerdown", 0, 0, { button: 2 });
    pointer("pointermove", -50, 0);
    pointer("pointerup", -50, 0);
    expect(goal.yaw).toBe(HOME_VIEW.yaw);
    expect(Math.hypot(goal.pan[0]!, goal.pan[2]!)).toBeCloseTo(50 * HOME_VIEW.distance * 0.0016, 5);
    const panned = [...goal.pan];
    pointer("pointerdown", 0, 0, { shift: true });
    pointer("pointermove", 0, 30);
    pointer("pointerup", 0, 30);
    expect([...goal.pan]).not.toEqual(panned);
    expect(goal.yaw).toBe(HOME_VIEW.yaw);
    expect(onTap).not.toHaveBeenCalled();

    expect(listeners.get("wheel")!.options).toEqual({ passive: false });
    const wheel = dispatch("wheel", { deltaY: 100 });
    expect(wheel.preventDefault).toHaveBeenCalled();
    expect(goal.distance).toBeCloseTo(HOME_VIEW.distance * Math.exp(0.12), 4);
    dispatch("wheel", { deltaY: -100000 });
    expect(goal.distance).toBe(ORBIT_LIMITS.minDistance);
    dispatch("wheel", { deltaY: 100000 });
    expect(goal.distance).toBe(ORBIT_LIMITS.maxDistance);
    expect(dispatch("contextmenu", {}).preventDefault).toHaveBeenCalled();
  });

  it("orbits with one finger, pinches with two, and taps with a still touch", () => {
    const { goal, onTap, pointer, input } = setup();
    pointer("pointerdown", 100, 100, { type: "touch", id: 1 });
    expect(input.engaged).toBe(true);
    pointer("pointermove", 80, 100, { type: "touch", id: 1 });
    expect(goal.yaw).toBeCloseTo(HOME_VIEW.yaw + 20 * 0.005, 6);
    pointer("pointerup", 80, 100, { type: "touch", id: 1 });
    expect(input.engaged).toBe(false);

    // Pinch out: the fingers spread to twice the distance, so the camera comes twice as close.
    const yaw = goal.yaw;
    pointer("pointerdown", 100, 100, { type: "touch", id: 1 });
    pointer("pointerdown", 200, 100, { type: "touch", id: 2 });
    pointer("pointermove", 50, 100, { type: "touch", id: 1 });
    pointer("pointermove", 250, 100, { type: "touch", id: 2 });
    expect(goal.distance).toBeCloseTo(HOME_VIEW.distance / 2, 4);
    expect(goal.yaw).toBe(yaw);
    pointer("pointerup", 50, 100, { type: "touch", id: 1 });
    pointer("pointerup", 250, 100, { type: "touch", id: 2 });
    expect(onTap).not.toHaveBeenCalled();

    pointer("pointerdown", 120, 140, { type: "touch", id: 3, time: 5000 });
    pointer("pointerup", 123, 142, { type: "touch", id: 3, time: 5100 });
    expect(onTap).toHaveBeenCalledExactlyOnceWith({ clientX: 123, clientY: 142, pointerType: "touch" });
  });

  it("keeps the pan on the board and removes every listener once", () => {
    const goal = orbitRig({ ...HOME_VIEW, yaw: 0 });
    panGround(goal, 1000, 1000);
    expect([goal.pan[0], goal.pan[2]]).toEqual([34, -34]);

    const { listeners, pointer, captured, input } = setup();
    expect([...listeners.keys()].sort()).toEqual(
      ["contextmenu", "pointercancel", "pointerdown", "pointerenter", "pointerleave", "pointermove", "pointerup", "wheel"]
    );
    pointer("pointerdown", 0, 0);
    // A second pointer whose capture the browser already dropped (its up event was missed).
    pointer("pointerdown", 5, 5, { id: 2 });
    captured.delete(2);
    expect(() => input.dispose()).not.toThrow();
    input.dispose();
    expect(listeners.size).toBe(0);
    expect(captured.size).toBe(0);
    expect(input.engaged).toBe(false);
  });
});
