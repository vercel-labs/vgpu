import { afterEach, expect, test, vi } from "vitest";
import { createMockGPUDevice, Device } from "@vgpu/core";
import { frame, frameLoop, init, initFromDevice, surface, target } from "../src/mock.ts";
import { FrameRunner } from "../src/frame.ts";
import { frameState } from "../src/frame-state.ts";
import { kernelOf } from "../src/kernel.ts";

type RafCallback = (timestamp: number) => void;

const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;

afterEach(() => {
  globalThis.requestAnimationFrame = originalRequestAnimationFrame;
  globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
  vi.restoreAllMocks();
});

test("gpu.lost is stable and resolves with the native loss info while active", async () => {
  const { device, lose } = losableDevice();
  const gpu = await initFromDevice(device);
  const lost = gpu.lost;
  const info = { reason: "unknown", message: "adapter reset" } as GPUDeviceLostInfo;

  expect(lost).toBeInstanceOf(Promise);
  expect(gpu.lost).toBe(lost);
  lose(info);

  await expect(lost).resolves.toBe(info);
  expect(gpu.disposed).toBe(false);
  expect(device.destroy).not.toHaveBeenCalled();
  gpu.dispose();
});

test("native loss stops every live loop before notification without another tick", async () => {
  const callbacks = mockAnimationFrames();
  const { device, lose } = losableDevice();
  const gpu = await initFromDevice(device);
  const order: string[] = [];
  const errors: unknown[] = [];
  let ticks = 0;
  gpu.onError((error) => errors.push(error));

  const stopped = frameLoop(gpu, () => { ticks += 1; });
  const stoppedNow = stopped.stop.bind(stopped);
  let stoppedCalls = 0;
  stopped.stop = () => { stoppedCalls += 1; stoppedNow(); };
  stopped.stop();

  const first = frameLoop(gpu, () => { ticks += 1; });
  const second = frameLoop(gpu, () => { ticks += 1; });
  const firstStop = first.stop.bind(first);
  const secondStop = second.stop.bind(second);
  first.stop = () => { order.push("first.stop"); firstStop(); };
  second.stop = () => { order.push("second.stop"); secondStop(); };
  const queued = [...callbacks.values()];
  void gpu.lost.then(() => { order.push("lost"); });

  lose({ reason: "unknown", message: "lost during loop" } as GPUDeviceLostInfo);
  await gpu.lost;
  await nextTurn();

  expect(order).toEqual(["first.stop", "second.stop", "lost"]);
  expect(stoppedCalls).toBe(1);
  expect(callbacks.size).toBe(0);
  for (const tick of queued) tick(16);
  expect(ticks).toBe(0);
  expect(callbacks.size).toBe(0);
  expect(errors).toEqual([]);
  gpu.dispose();
});

test("new frames, loops, and factories after loss fail before side effects", async () => {
  const callbacks = mockAnimationFrames();
  const { device, lose } = losableDevice();
  const gpu = await initFromDevice(device);
  const createTexture = vi.spyOn(device, "createTexture");
  const state = frameState(kernelOf(gpu));
  const canvas = canvasLike();
  const canvasSurface = surface(gpu, canvas, { format: "rgba8unorm" });
  let resizeEvents = 0;
  canvasSurface.onResize(() => { resizeEvents += 1; });
  (canvas as unknown as { clientWidth: number }).clientWidth = 12;

  lose({ reason: "destroyed", message: "owner destroyed it" } as GPUDeviceLostInfo);
  await gpu.lost;

  expect(() => frame(gpu)).toThrow(expect.objectContaining({
    code: "VGPU-DEVICE-LOST",
    fix: "Create a new Gpu with init(), then recreate its resources and restart the loop.",
  }));
  expect(state.frameCount).toBe(0);
  expect(resizeEvents).toBe(1);
  expect(canvas.width).toBe(10);
  expect(() => frameLoop(gpu, () => undefined)).toThrow(expect.objectContaining({ code: "VGPU-DEVICE-LOST" }));
  expect(callbacks.size).toBe(0);
  expect(() => target(gpu, { size: [1, 1] })).toThrow(expect.objectContaining({ code: "VGPU-DEVICE-LOST" }));
  expect(createTexture).not.toHaveBeenCalled();
  gpu.dispose();
  expect(() => frame(gpu)).toThrow(expect.objectContaining({ code: "VGPU-GPU-DISPOSED" }));
});

test("dispose before loss observation suppresses notification and cancels manual frames", async () => {
  for (const ownership of ["owned", "borrowed"] as const) {
    const { device, lose } = losableDevice();
    const gpu = ownership === "owned"
      ? await init({ adapter: { requestDevice: async () => new Device(device) } })
      : await initFromDevice(device);
    const pending = frame(gpu);
    const lost = promiseState(gpu.lost);

    lose({ reason: "destroyed", message: `${ownership} race` } as GPUDeviceLostInfo);
    gpu.dispose();
    await nextTurn();

    expect(gpu.disposed).toBe(true);
    expect(lost.state()).toBe("pending");
    expect(() => pending.submit()).not.toThrow();
    expect(device.destroy).toHaveBeenCalledTimes(ownership === "owned" ? 1 : 0);
  }
});

test("observed loss preserves manual-frame errors and remains resolved through disposal", async () => {
  for (const ownership of ["owned", "borrowed"] as const) {
    const { device, lose } = losableDevice();
    const gpu = ownership === "owned"
      ? await init({ adapter: { requestDevice: async () => new Device(device) } })
      : await initFromDevice(device);
    const pending = frame(gpu);
    const info = { reason: "unknown", message: `${ownership} device failed` } as GPUDeviceLostInfo;

    lose(info);
    expect(await gpu.lost).toBe(info);
    expect(gpu.disposed).toBe(false);
    expect(() => pending.submit()).toThrow(expect.objectContaining({
      code: "VGPU-DEVICE-LOST",
      cause: info,
    }));

    gpu.dispose();
    expect(await gpu.lost).toBe(info);
    expect(() => pending.submit()).not.toThrow();
    expect(device.destroy).not.toHaveBeenCalled();
  }
});

test("destroying a borrowed native device notifies loss, while wrapper disposal never destroys it", async () => {
  const lostInfo = { reason: "destroyed", message: "external owner destroyed it" } as GPUDeviceLostInfo;
  const { device } = losableDevice(lostInfo);
  const gpu = await initFromDevice(device);

  device.destroy();
  await expect(gpu.lost).resolves.toBe(lostInfo);
  expect(gpu.disposed).toBe(false);
  expect(device.destroy).toHaveBeenCalledOnce();

  gpu.dispose();
  expect(device.destroy).toHaveBeenCalledOnce();
});

test("a fresh init after loss has an independent active device and loss promise", async () => {
  const firstDevice = losableDevice();
  const first = await initFromDevice(firstDevice.device);
  firstDevice.lose({ reason: "unknown", message: "first failed" } as GPUDeviceLostInfo);
  await first.lost;

  const secondDevice = losableDevice();
  const second = await initFromDevice(secondDevice.device);
  expect(second.lost).not.toBe(first.lost);
  expect(promiseState(second.lost).state()).toBe("pending");
  expect(() => frame(second, () => undefined)).not.toThrow();

  first.dispose();
  second.dispose();
});

test("a rejected native loss signal never rejects gpu.lost", async () => {
  const rejection = new Error("hostile native loss promise");
  const device = Object.assign(createMockGPUDevice(), {
    lost: Promise.reject(rejection),
    destroy: vi.fn(),
  });
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  process.on("unhandledRejection", onUnhandled);

  try {
    const gpu = await initFromDevice(device);
    const state = promiseState(gpu.lost);
    await nextTurn();
    expect(state.state()).toBe("pending");
    expect(unhandled).toEqual([]);
    gpu.dispose();
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("user errors that only resemble device loss still escape", () => {
  const failure = { code: "VGPU-DEVICE-LOST", message: "user submit failed" };
  const runner = new FrameRunner(
    () => ({ submit: () => { throw failure; }, cancel: vi.fn() }) as never,
    vi.fn(),
  );

  expect(() => runner.frame(() => undefined)).toThrow(failure);
});

test.each(["fence", "delivery"] as const)(
  "loss after settled capture retains the fence and delivery when %s resolves first",
  async (first) => {
    const { device, lose } = losableDevice();
    const gpu = await initFromDevice(device);
    const fence = deferred<void>();
    const delivery = deferred<void>();
    vi.spyOn(device.queue, "onSubmittedWorkDone").mockReturnValue(fence.promise);
    void kernelOf(gpu).trackDelivery(delivery.promise);

    try {
      const settled = promiseState(gpu.settled());
      lose({ reason: "unknown", message: "loss after capture" } as GPUDeviceLostInfo);
      await gpu.lost;
      await nextTurn();
      expect(settled.state()).toBe("pending");

      if (first === "fence") fence.resolve();
      else delivery.resolve();
      await nextTurn();
      expect(settled.state()).toBe("pending");

      if (first === "fence") delivery.resolve();
      else fence.resolve();
      await nextTurn();
      expect(settled.state()).toBe("resolved");
    } finally {
      fence.resolve();
      delivery.resolve();
      gpu.dispose();
    }
  },
);

function losableDevice(destroyInfo?: GPUDeviceLostInfo) {
  let resolveLost!: (info: GPUDeviceLostInfo) => void;
  const base = createMockGPUDevice();
  const lost = new Promise<GPUDeviceLostInfo>((resolve) => { resolveLost = resolve; });
  const device = Object.assign(base, {
    lost,
    destroy: vi.fn(() => {
      if (destroyInfo) resolveLost(destroyInfo);
    }),
  });
  return { device, lose: resolveLost };
}

function mockAnimationFrames(): Map<number, RafCallback> {
  const callbacks = new Map<number, RafCallback>();
  let nextId = 1;
  globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
    const id = nextId++;
    callbacks.set(id, callback);
    return id;
  }) as typeof requestAnimationFrame;
  globalThis.cancelAnimationFrame = ((id: number) => { callbacks.delete(id); }) as typeof cancelAnimationFrame;
  return callbacks;
}

function canvasLike(): HTMLCanvasElement {
  const canvas: Record<string, unknown> = {
    width: 0,
    height: 0,
    clientWidth: 10,
    clientHeight: 5,
    getContext(kind: string) {
      if (kind !== "webgpu") return null;
      return {
        canvas,
        configure: vi.fn(),
        unconfigure: vi.fn(),
        getCurrentTexture: () => ({ createView: () => ({}) }),
      };
    },
  };
  return canvas as unknown as HTMLCanvasElement;
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function promiseState<T>(promise: Promise<T>) {
  let state: "pending" | "resolved" | "rejected" = "pending";
  void promise.then(() => { state = "resolved"; }, () => { state = "rejected"; });
  return { state: () => state };
}

function deferred<T>() {
  let resolve!: (value?: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}
