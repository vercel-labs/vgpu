import { afterEach, expect, test, vi } from "vitest";
import { init, clock, frame, target } from "../src/mock.ts";

afterEach(() => { vi.restoreAllMocks(); });

/** Drives `performance.now()` by hand so the wall-clock path is deterministic. */
function fakeWallClock(startMs = 1_000): { advanceMs(ms: number): void } {
  let nowMs = startMs;
  vi.spyOn(performance, "now").mockImplementation(() => nowMs);
  return { advanceMs(ms: number): void { nowMs += ms; } };
}

test("auto mode: every frame advances the clock with wall-clock time", async () => {
  const wall = fakeWallClock();
  const gpu = await init();
  const time = clock(gpu);
  const scene = target(gpu, { size: [2, 2] });

  expect([time.time, time.deltaTime, time.frameCount]).toEqual([0, 0, 0]);

  wall.advanceMs(16);
  frame(gpu, (currentFrame) => currentFrame.pass(scene, () => undefined));
  expect(time.deltaTime).toBeCloseTo(0.016, 10);
  expect(time.time).toBeCloseTo(0.016, 10);
  expect(time.frameCount).toBe(1);

  wall.advanceMs(34);
  frame(gpu);
  expect(time.deltaTime).toBeCloseTo(0.034, 10);
  expect(time.time).toBeCloseTo(0.05, 10);
  expect(time.frameCount).toBe(2);

  gpu.dispose();
});

test("manual mode: an external ticker owns the clock and frame() does not advance it again", async () => {
  const wall = fakeWallClock();
  const gpu = await init();
  const time = clock(gpu);

  for (let tick = 0; tick < 3; tick++) {
    time.advance(0.25);
    // Wall time keeps moving between ticks; the manual advance still wins.
    wall.advanceMs(1_000);
    frame(gpu);
  }

  expect(time.time).toBeCloseTo(0.75, 10);
  expect(time.deltaTime).toBeCloseTo(0.25, 10);
  expect(time.frameCount).toBe(3);
  gpu.dispose();
});

test("advance() moves the clock immediately and never counts a frame", async () => {
  fakeWallClock();
  const gpu = await init();
  const time = clock(gpu);

  time.advance(0.1);
  expect(time.time).toBeCloseTo(0.1, 10);
  expect(time.deltaTime).toBeCloseTo(0.1, 10);
  expect(time.frameCount).toBe(0);

  time.advance(0.2);
  expect(time.time).toBeCloseTo(0.30000000000000004, 10);
  expect(time.frameCount).toBe(0);

  frame(gpu);
  expect(time.time).toBeCloseTo(0.30000000000000004, 10);
  expect(time.frameCount).toBe(1);
  gpu.dispose();
});

test("mixing advance() and frame() in the same tick advances exactly once", async () => {
  const wall = fakeWallClock();
  const gpu = await init();
  const time = clock(gpu);

  wall.advanceMs(500);
  time.advance(1 / 60);
  frame(gpu);
  expect(time.time).toBeCloseTo(1 / 60, 10);
  expect(time.deltaTime).toBeCloseTo(1 / 60, 10);

  // The next frame has no manual advance, so it goes back to wall-clock deltas measured
  // from the previous tick — not from the last automatic one.
  wall.advanceMs(100);
  frame(gpu);
  expect(time.deltaTime).toBeCloseTo(0.1, 10);
  expect(time.time).toBeCloseTo(1 / 60 + 0.1, 10);
  expect(time.frameCount).toBe(2);
  gpu.dispose();
});

test("timescale: advancing with a scaled delta slows the clock down", async () => {
  const wall = fakeWallClock();
  const gpu = await init();
  const time = clock(gpu);
  const timescale = 0.5;
  let previousMs = performance.now();

  for (let tick = 0; tick < 4; tick++) {
    wall.advanceMs(20);
    const nowMs = performance.now();
    time.advance(((nowMs - previousMs) / 1000) * timescale);
    previousMs = nowMs;
    frame(gpu);
  }

  expect(time.time).toBeCloseTo(0.04, 10);
  expect(time.deltaTime).toBeCloseTo(0.01, 10);
  expect(time.frameCount).toBe(4);
  gpu.dispose();
});

test("fixed timestep: the same script produces the same clock, twice", async () => {
  const run = async (): Promise<readonly [number, number, number]> => {
    fakeWallClock(Math.random() * 10_000);
    const gpu = await init();
    const time = clock(gpu);
    for (let step = 0; step < 120; step++) {
      time.advance(1 / 60);
      frame(gpu);
    }
    const snapshot = [time.time, time.deltaTime, time.frameCount] as const;
    gpu.dispose();
    vi.restoreAllMocks();
    return snapshot;
  };

  const first = await run();
  const second = await run();
  expect(first).toEqual(second);
  expect(first[0]).toBeCloseTo(2, 10);
  expect(first[2]).toBe(120);
});

test("clock(gpu) is stable, rejects invalid deltas and dies with the gpu", async () => {
  const gpu = await init();
  const time = clock(gpu);

  expect(clock(gpu)).toBe(time);
  expect(() => time.advance(Number.NaN)).toThrowError(/clock\.advance\(\) received/);
  expect(() => time.advance(-1)).toThrowError(/clock\.advance\(\) received/);
  expect(() => time.advance("16" as never)).toThrowError(/clock\.advance\(\) received/);

  gpu.dispose();
  expect(() => clock(gpu)).toThrowError(/clock\(\) ran after gpu\.dispose\(\)/);
  expect(() => time.advance(1)).toThrowError(/clock\.advance\(\) ran after gpu\.dispose\(\)/);
  expect(() => time.time).toThrowError(/clock\.time\(\) ran after gpu\.dispose\(\)/);
});
