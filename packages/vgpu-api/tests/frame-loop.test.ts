import { afterEach, expect, test } from "vitest";
import { FrameRunner } from "../src/frame.ts";
import { init } from "../src/mock.ts";

type RafCallback = (timestamp: number) => void;

const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;

afterEach(() => {
  globalThis.requestAnimationFrame = originalRequestAnimationFrame;
  globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
});

test("FrameRunner.loop caps callbacks to the requested fps", () => {
  const callbacks = new Map<number, RafCallback>();
  let nextId = 1;
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    const id = nextId++;
    callbacks.set(id, cb);
    return id;
  }) as typeof requestAnimationFrame;
  globalThis.cancelAnimationFrame = ((id: number) => { callbacks.delete(id); }) as typeof cancelAnimationFrame;

  let submitted = 0;
  let advanced = 0;
  let calls = 0;
  const runner = new FrameRunner(
    () => ({ submit: () => { submitted += 1; } }) as never,
    () => { advanced += 1; },
  );

  const handle = runner.loop(() => { calls += 1; }, { fps: 30 });
  fire(callbacks, 1, 0);
  fire(callbacks, 2, 16);
  fire(callbacks, 3, 33);
  fire(callbacks, 4, 34);
  fire(callbacks, 5, 68);
  handle.stop();

  expect(calls).toBe(3);
  expect(submitted).toBe(3);
  expect(advanced).toBe(3);
  expect(callbacks.has(6)).toBe(false);
});

test("gpu.dispose() stops the render loops that gpu started", async () => {
  const callbacks = mockAnimationFrames();
  const gpu = await init();
  const target = gpu.target({ size: [4, 4] });
  const effect = gpu.effect(`@fragment fn fs_main() -> @location(0) vec4f { return vec4f(1); }`);

  let calls = 0;
  gpu.frame.loop((frame) => {
    calls += 1;
    frame.pass(target, effect);
  });
  fire(callbacks, 1, 0);
  expect(calls).toBe(1);

  // A tick can already be queued when dispose lands: keep the callback the loop rescheduled.
  const queuedTick = callbacks.get(2);
  expect(queuedTick).toBeDefined();
  gpu.dispose();

  // The handle was cancelled, and the tick that slipped through returns without touching the device.
  expect(callbacks.size).toBe(0);
  expect(() => queuedTick?.(16)).not.toThrow();
  expect(calls).toBe(1);
});

test("a loop stopped by hand is untracked, so gpu.dispose() has nothing left to stop", async () => {
  const callbacks = mockAnimationFrames();
  const gpu = await init();

  let calls = 0;
  const handle = gpu.frame.loop(() => { calls += 1; });
  fire(callbacks, 1, 0);
  handle.stop();
  expect(callbacks.size).toBe(0);

  expect(() => gpu.dispose()).not.toThrow();
  expect(calls).toBe(1);
});

test("disposing the gpu inside its loop callback does not enqueue one final tick", async () => {
  const callbacks = mockAnimationFrames();
  const gpu = await init();

  gpu.frame.loop(() => { gpu.dispose(); });
  fire(callbacks, 1, 0);

  // dispose() ran while tick 1 was executing. The tick must observe stop() before scheduling tick 2.
  expect(callbacks.size).toBe(0);
});

function mockAnimationFrames(): Map<number, RafCallback> {
  const callbacks = new Map<number, RafCallback>();
  let nextId = 1;
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    const id = nextId++;
    callbacks.set(id, cb);
    return id;
  }) as typeof requestAnimationFrame;
  globalThis.cancelAnimationFrame = ((id: number) => { callbacks.delete(id); }) as typeof cancelAnimationFrame;
  return callbacks;
}

function fire(callbacks: Map<number, RafCallback>, id: number, timestamp: number): void {
  const cb = callbacks.get(id);
  callbacks.delete(id);
  cb?.(timestamp);
}
