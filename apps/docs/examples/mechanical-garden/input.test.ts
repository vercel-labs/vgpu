import { orbitRig } from "vgpu/scene";
import { describe, expect, it, vi } from "vitest";

import { CURSOR_STEP, installInput, type InputElement, type Tool } from "./input";
import { HALF } from "./terrain";

function setup(initialTool: Tool = "orbit") {
  const listeners = new Map<string, EventListener>();
  const element: InputElement = {
    addEventListener: vi.fn((type: string, listener: EventListener) => {
      listeners.set(type, listener);
    }),
    removeEventListener: vi.fn((type: string, listener: EventListener) => {
      if (listeners.get(type) === listener) listeners.delete(type);
    }),
    setPointerCapture: vi.fn(),
    releasePointerCapture: vi.fn(),
    hasPointerCapture: vi.fn(() => false),
  };
  let tool = initialTool;
  /** Whether the pick ray hits the tile. */
  const ground = { hit: true };
  const goal = orbitRig({ target: [0, 0, 0], yaw: 0, pitch: 0.5, distance: 10 });
  const options = {
    tool: () => tool,
    pick: vi.fn((x: number, _y: number, out: [number, number]) => {
      if (!ground.hit) return false;
      out[0] = 0.5 + (x - 10) * 0.01;
      out[1] = -0.25;
      return true;
    }),
    onDestination: vi.fn(),
    onTool: vi.fn((next: Tool) => {
      tool = next;
    }),
    onPause: vi.fn(),
    onStep: vi.fn(),
  };
  const input = installInput(element, goal, options);
  const fire = (type: string, init: Record<string, unknown> = {}) => {
    const event = { type, preventDefault: vi.fn(), altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, repeat: false, ...init };
    listeners.get(type)?.(event as unknown as Event);
    return event;
  };
  /** Orbit rig state that any camera gesture would change. */
  const camera = () => [goal.yaw, goal.pitch, goal.distance, ...goal.pan];
  return { listeners, element, goal, ground, camera, options, input, fire, setTool: (next: Tool) => (tool = next) };
}

describe("keyboard equivalents", () => {
  it("number keys pick tools, P pauses and period steps", () => {
    const env = setup();
    for (const [key, tool] of [["2", "elevate"], ["3", "lower"], ["4", "destination"], ["1", "orbit"]] as const) {
      expect(env.fire("keydown", { key }).preventDefault).toHaveBeenCalled();
      expect(env.options.onTool).toHaveBeenLastCalledWith(tool);
    }
    env.fire("keydown", { key: "p" });
    // Holding P auto-repeats; only the first press toggles.
    expect(env.fire("keydown", { key: "p", repeat: true }).preventDefault).toHaveBeenCalled();
    env.fire("keydown", { key: "." });
    expect(env.options.onPause).toHaveBeenCalledOnce();
    expect(env.options.onStep).toHaveBeenCalledOnce();
    // Browser shortcuts pass through untouched.
    expect(env.fire("keydown", { key: "2", metaKey: true }).preventDefault).not.toHaveBeenCalled();
    expect(env.fire("keydown", { key: "Tab" }).preventDefault).not.toHaveBeenCalled();
    // Space never scrolls the page under a focused demo, even in Orbit where it does nothing.
    expect(env.fire("keydown", { key: " " }).preventDefault).toHaveBeenCalled();
    expect(env.fire("keydown", { key: "Enter" }).preventDefault).not.toHaveBeenCalled();
  });

  it("arrows orbit in orbit mode and move a bounded cursor in a tool mode", () => {
    const env = setup();
    const yaw = env.goal.yaw;
    env.fire("keydown", { key: "ArrowLeft" });
    expect(env.goal.yaw).not.toBe(yaw);
    expect(env.input.cursor.x).toBe(0);

    env.setTool("elevate");
    env.fire("focus");
    env.fire("keydown", { key: "ArrowRight" });
    // Right is the camera's right: (cos yaw, -sin yaw) on the ground.
    expect(env.input.cursor.x).toBeCloseTo(CURSOR_STEP * Math.cos(env.goal.yaw), 6);
    expect(env.input.cursor.z).toBeCloseTo(-CURSOR_STEP * Math.sin(env.goal.yaw), 6);
    expect(env.input.cursor.visible).toBe(true);
    for (let index = 0; index < 200; index++) env.fire("keydown", { key: "ArrowRight", shiftKey: true });
    expect(Number.isFinite(env.input.cursor.x)).toBe(true);
    expect(env.input.cursor.x).toBeCloseTo(HALF - 0.3, 6);
  });

  it("Enter holds a sculpt until keyup or blur, and sends the robots in destination mode", () => {
    const env = setup("elevate");
    env.fire("focus");
    env.fire("keydown", { key: "Enter" });
    expect(env.input.cursor.pressed).toBe(true);
    expect(env.input.engaged).toBe(true);
    env.fire("keyup", { key: "Enter" });
    expect(env.input.cursor.pressed).toBe(false);

    // With both keys down, the sculpt lasts until the last one is released.
    env.fire("keydown", { key: "Enter" });
    env.fire("keydown", { key: " " });
    env.fire("keyup", { key: "Enter" });
    expect(env.input.cursor.pressed).toBe(true);
    env.fire("keyup", { key: " " });
    expect(env.input.cursor.pressed).toBe(false);

    env.fire("keydown", { key: " " });
    env.fire("blur");
    expect(env.input.cursor.pressed).toBe(false);

    env.setTool("destination");
    env.fire("keydown", { key: "Enter" });
    env.fire("keydown", { key: "Enter", repeat: true });
    expect(env.options.onDestination).toHaveBeenCalledOnce();
    expect(env.input.cursor.pressed).toBe(false);
  });
});

describe("pointer", () => {
  it("a sculpt press follows the picked terrain point and releases on pointerup", () => {
    const env = setup("elevate");
    env.fire("pointerdown", { pointerId: 1, pointerType: "mouse", button: 0, buttons: 1, isPrimary: true, clientX: 10, clientY: 10, timeStamp: 0 });
    expect(env.input.cursor.pressed).toBe(true);
    expect(env.input.cursor.x).toBe(0.5);
    expect(env.input.cursor.z).toBe(-0.25);
    env.fire("pointerup", { pointerId: 1, pointerType: "mouse", button: 0, buttons: 0, isPrimary: true, clientX: 10, clientY: 10, timeStamp: 50 });
    expect(env.input.cursor.pressed).toBe(false);
  });
});

describe("taps, drags and two fingers", () => {
  const finger = (pointerId: number, clientX: number, clientY: number, timeStamp: number, buttons = 1) => ({
    pointerId,
    pointerType: "touch",
    button: 0,
    buttons,
    isPrimary: pointerId === 1,
    clientX,
    clientY,
    timeStamp,
  });

  it("in destination mode a drag aims and the release sends the robots, without moving the camera", () => {
    const env = setup("destination");
    const camera = env.camera();
    env.fire("pointerdown", finger(1, 10, 100, 0));
    env.fire("pointermove", finger(1, 60, 100, 40));
    expect(env.options.onDestination).not.toHaveBeenCalled();
    expect(env.input.cursor.visible).toBe(true);
    env.fire("pointerup", finger(1, 60, 100, 80, 0));
    expect(env.camera()).toEqual(camera);
    expect(env.options.onDestination).toHaveBeenCalledExactlyOnceWith(1, -0.25);
    // Neither a cancelled press nor a lost capture is a release.
    for (const end of ["pointercancel", "lostpointercapture"]) {
      env.fire("pointerdown", finger(1, 10, 100, 1000));
      env.fire(end, finger(1, 10, 100, 1050, 0));
    }
    expect(env.options.onDestination).toHaveBeenCalledOnce();
    // A release off the tile sends nothing either.
    env.fire("pointerdown", finger(1, 10, 100, 2000));
    env.ground.hit = false;
    env.fire("pointermove", finger(1, 20, 100, 2040));
    env.fire("pointerup", finger(1, 20, 100, 2080, 0));
    expect(env.options.onDestination).toHaveBeenCalledOnce();
  });

  it("a second finger stops a sculpt and pinches to zoom, and the first finger never resumes sculpting", () => {
    const env = setup("elevate");
    env.fire("pointerdown", finger(1, 100, 100, 0));
    expect(env.input.cursor.pressed).toBe(true);
    env.fire("pointerdown", finger(2, 200, 100, 20));
    expect(env.input.cursor.pressed).toBe(false);
    // Spreading the fingers dollies in; moving both together does not orbit in an edit tool.
    const distance = env.goal.distance;
    env.fire("pointermove", finger(1, 50, 100, 40));
    env.fire("pointermove", finger(2, 250, 100, 40));
    expect(env.goal.distance).toBeLessThan(distance);
    const yaw = env.goal.yaw;
    env.fire("pointermove", finger(1, 90, 100, 60));
    env.fire("pointermove", finger(2, 290, 100, 60));
    expect(env.goal.yaw).toBe(yaw);
    // Lifting the second finger leaves an orbiting first finger, not a sculpt.
    env.fire("pointerup", finger(2, 290, 100, 80, 0));
    env.fire("pointermove", finger(1, 120, 120, 100));
    expect(env.input.cursor.pressed).toBe(false);
    env.fire("pointerup", finger(1, 120, 120, 120, 0));
    expect(env.input.cursor.pressed).toBe(false);
    expect(env.input.cursor.visible).toBe(false);
    // The next single press sculpts again.
    env.fire("pointerdown", finger(3, 100, 100, 500));
    expect(env.input.cursor.pressed).toBe(true);
  });

  it("two fingers orbit and pinch in the orbit tool", () => {
    const env = setup("orbit");
    env.fire("pointerdown", finger(1, 100, 100, 0));
    env.fire("pointerdown", finger(2, 200, 100, 10));
    const yaw = env.goal.yaw;
    env.fire("pointermove", finger(1, 140, 100, 30));
    env.fire("pointermove", finger(2, 240, 100, 30));
    expect(env.goal.yaw).not.toBe(yaw);
  });

  it("a destination press that grew a second finger is a zoom gesture, not a destination", () => {
    const env = setup("destination");
    env.fire("pointerdown", finger(1, 100, 100, 0));
    env.fire("pointerdown", finger(2, 160, 100, 10));
    env.fire("pointerup", finger(2, 160, 100, 30, 0));
    env.fire("pointerup", finger(1, 100, 100, 50, 0));
    expect(env.options.onDestination).not.toHaveBeenCalled();
  });
});

describe("cursor visibility", () => {
  const touch = { pointerId: 7, pointerType: "touch", button: 0, buttons: 1, isPrimary: true, clientX: 10, clientY: 10 };

  it("a touch sculpt that focuses the canvas leaves no cursor once the finger lifts", () => {
    const env = setup("elevate");
    env.fire("pointerdown", { ...touch, timeStamp: 0 });
    // The tap focuses the (tabIndex 0) canvas after the press.
    env.fire("focus");
    expect(env.input.cursor.visible).toBe(true);
    env.fire("pointerup", { ...touch, buttons: 0, timeStamp: 900 });
    expect(env.input.cursor.visible).toBe(false);
    expect(env.input.keyboard).toBe(false);
    // A key press on the still-focused canvas brings the keyboard cursor back.
    env.fire("keydown", { key: "ArrowUp" });
    expect(env.input.cursor.visible).toBe(true);
    expect(env.input.keyboard).toBe(true);
  });

  it("keyboard focus shows the cursor in a tool mode; a press hands it back to the pointer", () => {
    const env = setup("lower");
    env.fire("focus");
    expect(env.input.cursor.visible).toBe(true);
    env.fire("pointerdown", { ...touch, timeStamp: 0 });
    env.fire("pointerup", { ...touch, buttons: 0, timeStamp: 900 });
    expect(env.input.cursor.visible).toBe(false);
  });

  it("an ignored right or middle press that focuses the canvas is not keyboard focus", () => {
    for (const button of [1, 2]) {
      const env = setup("elevate");
      // Keyboard use earlier left the cursor somewhere; then the canvas lost focus.
      env.fire("focus");
      env.fire("keydown", { key: "ArrowUp" });
      env.fire("blur");
      env.fire("pointerdown", { pointerId: 3, pointerType: "mouse", button, buttons: 1 << button, isPrimary: true, clientX: 10, clientY: 10 });
      env.fire("focus");
      expect(env.input.keyboard).toBe(false);
      expect(env.input.cursor.visible).toBe(false);
      // Tabbing back in later is keyboard focus again.
      env.fire("blur");
      env.fire("focus");
      expect(env.input.cursor.visible).toBe(true);
    }
  });
});

describe("exclusive edit tools", () => {
  // Each of these orbited, panned or kept sculpting with the previous input model.
  const mouse = (clientX: number, clientY: number, timeStamp: number, init: Record<string, unknown> = {}) => ({
    pointerId: 1,
    pointerType: "mouse",
    button: 0,
    buttons: 1,
    isPrimary: true,
    clientX,
    clientY,
    timeStamp,
    ...init,
  });

  for (const tool of ["elevate", "lower", "destination"] as const) {
    it(`${tool}: a press that misses the tile never orbits, and starts editing once it reaches the tile`, () => {
      const env = setup(tool);
      const camera = env.camera();
      env.ground.hit = false;
      env.fire("pointerdown", mouse(10, 10, 0));
      env.fire("pointermove", mouse(80, 40, 20));
      env.fire("pointermove", mouse(140, 90, 40));
      expect(env.camera()).toEqual(camera);
      expect(env.input.cursor.pressed).toBe(false);
      env.ground.hit = true;
      env.fire("pointermove", mouse(150, 90, 60));
      expect(env.input.cursor.pressed).toBe(tool !== "destination");
      expect(env.input.cursor.x).toBeCloseTo(0.5 + 140 * 0.01, 9);
      env.fire("pointerup", mouse(150, 90, 80, { buttons: 0 }));
      expect(env.camera()).toEqual(camera);
    });
  }

  it("Shift-drag sculpts and right-drag does nothing in an edit tool", () => {
    const env = setup("elevate");
    const camera = env.camera();
    env.fire("pointerdown", mouse(10, 10, 0, { shiftKey: true }));
    expect(env.input.cursor.pressed).toBe(true);
    env.fire("pointermove", mouse(90, 60, 20, { shiftKey: true }));
    env.fire("pointerup", mouse(90, 60, 40, { buttons: 0, shiftKey: true }));
    env.fire("pointerdown", mouse(10, 10, 100, { button: 2, buttons: 2 }));
    env.fire("pointermove", mouse(90, 60, 120, { buttons: 2 }));
    expect(env.input.cursor.pressed).toBe(false);
    env.fire("pointerup", mouse(90, 60, 140, { button: 2, buttons: 0 }));
    expect(env.camera()).toEqual(camera);
    // The same gestures in the orbit tool do move the camera.
    env.setTool("orbit");
    env.fire("pointerdown", mouse(10, 10, 200, { shiftKey: true }));
    env.fire("pointermove", mouse(90, 60, 220, { shiftKey: true }));
    env.fire("pointerup", mouse(90, 60, 240, { buttons: 0 }));
    expect(env.goal.pan).not.toEqual(camera.slice(3));
    const yaw = env.goal.yaw;
    env.fire("pointerdown", mouse(10, 10, 300));
    env.fire("pointermove", mouse(90, 60, 320));
    expect(env.goal.yaw).not.toBe(yaw);
  });

  it("two fingers in an edit tool only pinch-zoom", () => {
    const env = setup("lower");
    const touch = (pointerId: number, clientX: number, clientY: number) => ({ pointerId, pointerType: "touch", button: 0, buttons: 1, isPrimary: pointerId === 1, clientX, clientY, timeStamp: 0 });
    const [yaw, pitch] = [env.goal.yaw, env.goal.pitch];
    const distance = env.goal.distance;
    env.fire("pointerdown", touch(1, 100, 100));
    env.fire("pointerdown", touch(2, 200, 100));
    env.fire("pointermove", touch(1, 60, 140));
    env.fire("pointermove", touch(2, 260, 140));
    expect(env.goal.distance).toBeLessThan(distance);
    expect([env.goal.yaw, env.goal.pitch]).toEqual([yaw, pitch]);
    expect(env.input.cursor.pressed).toBe(false);
  });

  it("cancel() drops a sculpt press and a held key, and the old pointer no longer edits or orbits", () => {
    const env = setup("elevate");
    env.fire("pointerdown", mouse(10, 10, 0));
    expect(env.input.cursor.pressed).toBe(true);
    env.input.cancel();
    expect(env.input.cursor.pressed).toBe(false);
    expect(env.input.engaged).toBe(false);
    // The tool switches mid-drag: the old press neither sculpts nor orbits in the new tool.
    env.setTool("orbit");
    const camera = env.camera();
    env.fire("pointermove", mouse(90, 60, 20));
    env.fire("pointerup", mouse(90, 60, 40, { buttons: 0 }));
    expect(env.camera()).toEqual(camera);
    env.setTool("elevate");
    env.fire("focus");
    env.fire("keydown", { key: "Enter" });
    expect(env.input.cursor.pressed).toBe(true);
    env.input.cancel();
    expect(env.input.cursor.pressed).toBe(false);
  });

  for (const end of ["pointercancel", "lostpointercapture"]) {
    it(`${end} ends a sculpt press`, () => {
      const env = setup("elevate");
      env.fire("pointerdown", mouse(10, 10, 0));
      expect(env.input.cursor.pressed).toBe(true);
      env.fire(end, mouse(10, 10, 20, { buttons: 0 }));
      expect(env.input.cursor.pressed).toBe(false);
      expect(env.input.engaged).toBe(false);
    });
  }

  it("a pointer that cannot be captured still sculpts and ends on pointerup", () => {
    const env = setup("elevate");
    vi.mocked(env.element.setPointerCapture!).mockImplementation(() => {
      throw new DOMException("No active pointer with the given id is found.", "NotFoundError");
    });
    expect(() => env.fire("pointerdown", mouse(10, 10, 0))).not.toThrow();
    expect(env.input.cursor.pressed).toBe(true);
    env.fire("pointerup", mouse(10, 10, 0, { buttons: 0 }));
    expect(env.input.cursor.pressed).toBe(false);
  });

  it("the wheel zooms in every tool", () => {
    for (const tool of ["orbit", "elevate", "lower", "destination"] as const) {
      const env = setup(tool);
      const distance = env.goal.distance;
      expect(env.fire("wheel", { deltaY: -200 }).preventDefault).toHaveBeenCalled();
      expect(env.goal.distance).toBeLessThan(distance);
    }
  });
});

describe("lifecycle", () => {
  it("dispose removes every listener once", () => {
    const env = setup();
    expect(env.listeners.size).toBe(13);
    env.input.dispose();
    env.input.dispose();
    expect(env.listeners.size).toBe(0);
    expect(env.element.removeEventListener).toHaveBeenCalledTimes(13);
  });

  it("a failing install removes what it added", () => {
    const added = new Set<string>();
    let calls = 0;
    const element: InputElement = {
      addEventListener: (type) => {
        if (++calls === 5) throw new Error("add failed");
        added.add(type);
      },
      removeEventListener: (type) => {
        added.delete(type);
      },
    };
    expect(() =>
      installInput(element, orbitRig({ target: [0, 0, 0] }), {
        tool: () => "orbit",
        pick: () => false,
        onDestination: () => {},
        onTool: () => {},
        onPause: () => {},
        onStep: () => {},
      }),
    ).toThrow("add failed");
    expect(added.size).toBe(0);
  });
});
