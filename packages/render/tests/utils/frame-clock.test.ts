import { afterEach, describe, expect, test, vi } from "vitest";
import { frameClock } from "@vgpu/render/utils";

let now = 0;

afterEach(() => vi.restoreAllMocks());

function installClock(): void {
  now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
}

describe("frameClock", () => {
  test("reports elapsed seconds", () => {
    installClock();
    const clock = frameClock();
    expect(clock.now()).toBeCloseTo(0);
    now = 1000;
    expect(clock.now()).toBeCloseTo(1);
  });

  test("reports delta since the last delta call", () => {
    installClock();
    const clock = frameClock();
    now = 1000;
    expect(clock.delta()).toBeCloseTo(1);
    expect(clock.delta()).toBeCloseTo(0);
  });

  test("excludes paused time", () => {
    installClock();
    const clock = frameClock();
    now = 500;
    clock.pause();
    expect(clock.isPaused).toBe(true);
    now = 2000;
    expect(clock.delta()).toBe(0);
    clock.resume();
    expect(clock.isPaused).toBe(false);
    now = 2500;
    expect(clock.now()).toBeCloseTo(1);
  });

  test("reset clears elapsed time and pause state", () => {
    installClock();
    const clock = frameClock();
    now = 1000;
    clock.pause();
    now = 2000;
    clock.reset();
    expect(clock.isPaused).toBe(false);
    expect(clock.now()).toBeCloseTo(0);
  });
});
