import { afterEach, expect, test, vi } from "vitest";
import { FrameRunner } from "../src/frame.ts";
import { init, effect, frame, frameLoop, target } from "../src/mock.ts";

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

test("FrameRunner.frame cancels the frame when the callback throws and rethrows the callback's own error", () => {
  // A test double for the frame, like the fps test above: the runner must only use the public
  // submit()/cancel() surface here and never let its own bookkeeping throw over the callback.
  const submit = vi.fn();
  const cancel = vi.fn();
  const runner = new FrameRunner(() => ({ submit, cancel }) as never, () => undefined);
  const failure = new Error("tick failed");

  let thrown: unknown;
  try { runner.frame(() => { throw failure; }); }
  catch (error) { thrown = error; }

  expect(thrown).toBe(failure);
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(submit).not.toHaveBeenCalled();
});

test("a loop tick whose callback throws submits nothing for that frame and stops the loop", async () => {
  const callbacks = mockAnimationFrames();
  const gpu = await init();
  const submits = spyQueueSubmits(gpu.device.gpu);
  const colorTarget = target(gpu, { size: [4, 4] });
  const failure = new Error("tick failed");
  let tick = 0;

  const handle = frameLoop(gpu, (currentFrame) => {
    tick += 1;
    currentFrame.pass(colorTarget, () => undefined);
    if (tick === 2) throw failure;
  });
  fire(callbacks, 1, 0);
  expect(submits.count).toBe(1);

  let thrown: unknown;
  try { fire(callbacks, 2, 16); }
  catch (error) { thrown = error; }

  // The failed tick's command buffer never reached the queue, and the error escaped the rAF
  // callback untouched — which also means no further tick was scheduled: the loop is over.
  expect(thrown).toBe(failure);
  expect(submits.count).toBe(1);
  expect(callbacks.size).toBe(0);
  expect(() => handle.stop()).not.toThrow();
  await gpu.settled();
  gpu.dispose();
  vi.restoreAllMocks();
});

test("a loop ended by a throwing tick drops its gpu registration, like handle.stop() does", () => {
  const callbacks = mockAnimationFrames();
  const untrack = vi.fn();
  const trackLoop = vi.fn(() => untrack);
  const runner = new FrameRunner(() => ({ submit: () => undefined, cancel: () => undefined }) as never, () => undefined, trackLoop);

  runner.loop(() => { throw new Error("tick failed"); });
  expect(trackLoop).toHaveBeenCalledTimes(1);
  expect(() => fire(callbacks, 1, 0)).toThrowError(/tick failed/);

  // Nothing will ever run this loop again, so gpu.dispose() must not keep holding it.
  expect(untrack).toHaveBeenCalledTimes(1);
  expect(callbacks.size).toBe(0);
});

test("gpu.dispose() stops the render loops that gpu started", async () => {
  const callbacks = mockAnimationFrames();
  const gpu = await init();
  const colorTarget = target(gpu, { size: [4, 4] });
  const shader = effect(gpu, `@fragment fn fs_main() -> @location(0) vec4f { return vec4f(1); }`);

  let calls = 0;
  frameLoop(gpu, (currentFrame) => {
    calls += 1;
    currentFrame.pass(colorTarget, shader);
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
  const handle = frameLoop(gpu, () => { calls += 1; });
  fire(callbacks, 1, 0);
  handle.stop();
  expect(callbacks.size).toBe(0);

  expect(() => gpu.dispose()).not.toThrow();
  expect(calls).toBe(1);
});

test("disposing the gpu inside its loop callback does not enqueue one final tick", async () => {
  const callbacks = mockAnimationFrames();
  const gpu = await init();

  frameLoop(gpu, () => { gpu.dispose(); });
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

/** Counts command buffers handed to the queue, matching frame-cancel.test.ts / frame-atomic.test.ts. */
function spyQueueSubmits(device: GPUDevice): { readonly count: number } {
  const counter = { count: 0 };
  const original = device.queue.submit.bind(device.queue);
  vi.spyOn(device.queue, "submit").mockImplementation((buffers: Iterable<GPUCommandBuffer>) => {
    counter.count += 1;
    original(buffers);
  });
  return counter;
}

function fire(callbacks: Map<number, RafCallback>, id: number, timestamp: number): void {
  const cb = callbacks.get(id);
  callbacks.delete(id);
  cb?.(timestamp);
}

test("dispose stops the loops before the device goes down, then tears down once", async () => {
  const callbacks = mockAnimationFrames();
  const gpu = await init();
  const order: string[] = [];

  const handle = frameLoop(gpu, () => undefined);
  const stop = handle.stop.bind(handle);
  handle.stop = () => { order.push("loop.stop"); stop(); };
  const colorTarget = target(gpu, { size: [4, 4] });
  const shader = effect(gpu, `@fragment fn fs_main() -> @location(0) vec4f { return vec4f(1); }`);
  frame(gpu, (currentFrame) => currentFrame.pass(colorTarget, shader)); // materializes the pipeline cache
  vi.spyOn(gpu.device, "dispose").mockImplementation(() => { order.push("device.dispose"); });

  gpu.dispose();
  gpu.dispose();

  // Schedulers first, device last, and exactly once each: a rAF tick landing mid-teardown must not
  // encode against a device that is already gone.
  expect(order).toEqual(["loop.stop", "device.dispose"]);
  expect(callbacks.size).toBe(0);
});
