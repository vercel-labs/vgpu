import { describe, expect, test } from "vitest";
import {
  createNodeAdapter,
  frame,
  frameLoop,
  initFromDevice,
} from "../../src/node.ts";

type RafCallback = (timestamp: number) => void;

const native = process.env.VGPU_DOCKER_TEST === "1"
  || process.env.VGPU_NATIVE_COMPUTE_TEST === "1";

describe.skipIf(!native)("native device loss", () => {
  test("destroying a borrowed device stops loops before notification and preserves manual submit errors", async () => {
    const owner = await createNodeAdapter().requestDevice();
    const raw = owner.gpu;
    const gpu = await initFromDevice(raw);
    const callbacks = new Map<number, RafCallback>();
    const originalRequest = globalThis.requestAnimationFrame;
    const originalCancel = globalThis.cancelAnimationFrame;
    let nextId = 1;
    globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      const id = nextId++;
      callbacks.set(id, callback);
      return id;
    }) as typeof requestAnimationFrame;
    globalThis.cancelAnimationFrame = ((id: number) => { callbacks.delete(id); }) as typeof cancelAnimationFrame;

    try {
      let ticks = 0;
      const errors: unknown[] = [];
      gpu.onError((error) => errors.push(error));
      frameLoop(gpu, () => { ticks += 1; });
      const queued = [...callbacks.values()];
      const pending = frame(gpu);
      const nativeLost = raw.lost;

      const observed = gpu.lost.then((info) => {
        expect(callbacks.size).toBe(0);
        return info;
      });
      raw.destroy();
      const [info, nativeInfo] = await Promise.all([observed, nativeLost]);

      expect(info).toBe(nativeInfo);
      expect(info.reason).toBe("destroyed");
      expect(gpu.disposed).toBe(false);
      expect(errors).toEqual([]);
      for (const tick of queued) tick(16);
      expect(ticks).toBe(0);
      expect(callbacks.size).toBe(0);
      expect(() => pending.submit()).toThrow(expect.objectContaining({
        code: "VGPU-DEVICE-LOST",
        cause: nativeInfo,
      }));

      gpu.dispose();
      expect(() => pending.submit()).not.toThrow();
    } finally {
      globalThis.requestAnimationFrame = originalRequest;
      globalThis.cancelAnimationFrame = originalCancel;
      gpu.dispose();
      owner.dispose();
    }
  });

  test("disposing a borrowed wrapper leaves the native device usable and lost pending", async () => {
    const owner = await createNodeAdapter().requestDevice();
    const raw = owner.gpu;
    const gpu = await initFromDevice(raw);
    const pending = frame(gpu);
    const lost = promiseState(gpu.lost);

    try {
      gpu.dispose();
      pending.submit();
      const encoder = raw.createCommandEncoder();
      raw.queue.submit([encoder.finish()]);
      await raw.queue.onSubmittedWorkDone();
      await nextTurn();

      expect(gpu.disposed).toBe(true);
      expect(lost()).toBe("pending");
    } finally {
      gpu.dispose();
      owner.dispose();
    }
  });
});

function promiseState<T>(promise: Promise<T>) {
  let state: "pending" | "resolved" | "rejected" = "pending";
  void promise.then(() => { state = "resolved"; }, () => { state = "rejected"; });
  return () => state;
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
