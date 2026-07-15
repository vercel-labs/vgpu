import { afterEach, expect, test } from "vitest";
import { FrameRunner } from "../src/frame.ts";

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

function fire(callbacks: Map<number, RafCallback>, id: number, timestamp: number): void {
  const cb = callbacks.get(id);
  callbacks.delete(id);
  cb?.(timestamp);
}
