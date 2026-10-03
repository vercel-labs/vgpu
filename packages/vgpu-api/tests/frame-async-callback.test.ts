import { prepareShader } from "@vgpu/wgsl/prepare";
import { afterEach, expect, test, vi } from "vitest";
import { compute, createMockAdapter, effect, frame, frameLoop, getMockGPUDeviceInstrumentation, init, target, timer, visibility, type Frame, type FrameLoopCallback, type FrameLoopHandle } from "../src/mock.ts";

type RafCallback = (timestamp: number) => void;

const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;

afterEach(() => {
  globalThis.requestAnimationFrame = originalRequestAnimationFrame;
  globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
  vi.restoreAllMocks();
});

test("frame rejects an erased Promise result before implicit submit and cancels the frame", async () => {
  const gpu = await init();
  const submits = spyQueueSubmits(gpu.device.gpu);
  const colorTarget = target(gpu, { size: [4, 4] });
  let retained: Frame | undefined;
  const erasedCallback: FrameLoopCallback = (currentFrame) => {
    retained = currentFrame;
    currentFrame.pass(colorTarget, () => undefined);
    return Promise.resolve();
  };

  let thrown: unknown;
  try { frame(gpu, erasedCallback); }
  catch (error) { thrown = error; }

  expect(thrown).toMatchObject({
    code: "VGPU-ASYNC-FRAME-CALLBACK",
    where: "frame",
    fix: "Await preparation before frame()/frameLoop(); keep the frame callback synchronous.",
  });
  expect(submits.count).toBe(0);
  expect(() => retained?.pass(colorTarget, () => undefined)).toThrow(expect.objectContaining({ code: "VGPU-FRAME-CANCELED" }));
  await expect(retained?.done).resolves.toBeUndefined();
  await gpu.settled();
  gpu.dispose();
});

test("frame rejects a thenable returned through an any-erased callback", async () => {
  const gpu = await init();
  const submits = spyQueueSubmits(gpu.device.gpu);
  const erasedAnyCallback: (currentFrame: Frame) => any = () => Promise.resolve();

  expect(() => frame(gpu, erasedAnyCallback)).toThrow(expect.objectContaining({
    code: "VGPU-ASYNC-FRAME-CALLBACK",
    where: "frame",
  }));
  expect(submits.count).toBe(0);
  await gpu.settled();
  gpu.dispose();
});

test.each([
  ["object-valued", () => ({ then: (resolve: (value?: unknown) => void) => { resolve(); } })],
  ["function-valued", () => Object.assign(() => undefined, { then: (resolve: (value?: unknown) => void) => { resolve(); } })],
])("frame rejects a callable .then on a %s result", async (_kind, createThenable) => {
  const gpu = await init();
  const submits = spyQueueSubmits(gpu.device.gpu);
  const erasedCallback: FrameLoopCallback = () => createThenable();

  expect(() => frame(gpu, erasedCallback)).toThrow(expect.objectContaining({
    code: "VGPU-ASYNC-FRAME-CALLBACK",
    where: "frame",
  }));
  expect(submits.count).toBe(0);
  await Promise.resolve();
  gpu.dispose();
});

test("a throwing then accessor cancels the frame and rethrows the original error", async () => {
  const gpu = await init();
  const submits = spyQueueSubmits(gpu.device.gpu);
  const colorTarget = target(gpu, { size: [4, 4] });
  const failure = new Error("then getter failed");
  let retained: Frame | undefined;
  const result = Object.defineProperty({}, "then", { get: () => { throw failure; } });
  const erasedCallback: FrameLoopCallback = (currentFrame) => {
    retained = currentFrame;
    currentFrame.pass(colorTarget, () => undefined);
    return result;
  };

  let thrown: unknown;
  try { frame(gpu, erasedCallback); }
  catch (error) { thrown = error; }

  expect(thrown).toBe(failure);
  expect(submits.count).toBe(0);
  expect(() => retained?.pass(colorTarget, () => undefined)).toThrow(expect.objectContaining({ code: "VGPU-FRAME-CANCELED" }));
  await expect(retained?.done).resolves.toBeUndefined();
  gpu.dispose();
});

test("a rejected callback Promise is consumed without unhandled rejection or gpu.onError delivery", async () => {
  const gpu = await init();
  const errors: unknown[] = [];
  const unhandled: unknown[] = [];
  const unsubscribe = gpu.onError((error) => { errors.push(error); });
  const onUnhandled = (error: unknown) => { unhandled.push(error); };
  process.on("unhandledRejection", onUnhandled);
  const failure = new Error("async callback rejected");
  const erasedCallback: FrameLoopCallback = () => Promise.reject(failure);

  try {
    expect(() => frame(gpu, erasedCallback)).toThrow(expect.objectContaining({ code: "VGPU-ASYNC-FRAME-CALLBACK" }));
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    await gpu.settled();
    expect(unhandled).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    process.off("unhandledRejection", onUnhandled);
    unsubscribe();
    gpu.dispose();
  }
});

test("a never-settling callback result does not delay cancellation or gpu.settled", async () => {
  const gpu = await init();
  const submits = spyQueueSubmits(gpu.device.gpu);
  const never = new Promise<void>(() => undefined);
  const erasedCallback: FrameLoopCallback = () => never;

  expect(() => frame(gpu, erasedCallback)).toThrow(expect.objectContaining({ code: "VGPU-ASYNC-FRAME-CALLBACK" }));
  expect(submits.count).toBe(0);
  await gpu.settled();
  gpu.dispose();
});

test("an explicit submit before the invalid result stays submitted and preserves the callback error", async () => {
  const gpu = await init();
  const submits = spyQueueSubmits(gpu.device.gpu);
  const colorTarget = target(gpu, { size: [4, 4] });
  let retained: Frame | undefined;
  let cancel: ReturnType<typeof vi.spyOn> | undefined;
  const erasedCallback: FrameLoopCallback = (currentFrame) => {
    retained = currentFrame;
    cancel = vi.spyOn(currentFrame, "cancel");
    currentFrame.pass(colorTarget, () => undefined);
    currentFrame.submit();
    return Promise.resolve();
  };

  expect(() => frame(gpu, erasedCallback)).toThrow(expect.objectContaining({
    code: "VGPU-ASYNC-FRAME-CALLBACK",
    where: "frame",
  }));
  expect(submits.count).toBe(1);
  expect(cancel).not.toHaveBeenCalled();
  await expect(retained?.done).resolves.toBeUndefined();
  gpu.dispose();
});

test("an explicit cancel before the invalid result is not repeated or masked", async () => {
  const gpu = await init();
  const submits = spyQueueSubmits(gpu.device.gpu);
  let cancel: ReturnType<typeof vi.spyOn> | undefined;
  const erasedCallback: FrameLoopCallback = (currentFrame) => {
    cancel = vi.spyOn(currentFrame, "cancel");
    currentFrame.cancel();
    return Promise.resolve();
  };

  expect(() => frame(gpu, erasedCallback)).toThrow(expect.objectContaining({
    code: "VGPU-ASYNC-FRAME-CALLBACK",
    where: "frame",
  }));
  expect(submits.count).toBe(0);
  expect(cancel).toHaveBeenCalledTimes(1);
  gpu.dispose();
});

test("frameLoop registration stays synchronous and an invalid tick stops and untracks the loop", async () => {
  const callbacks = mockAnimationFrames();
  const gpu = await init();
  const submits = spyQueueSubmits(gpu.device.gpu);
  let calls = 0;
  const erasedCallback: FrameLoopCallback = () => {
    calls += 1;
    return Promise.resolve();
  };
  let handle: FrameLoopHandle | undefined;

  expect(() => { handle = frameLoop(gpu, erasedCallback); }).not.toThrow();
  expect(calls).toBe(0);
  expect(callbacks.size).toBe(1);
  let thrown: unknown;
  try { fire(callbacks, 1, 0); }
  catch (error) { thrown = error; }

  expect(thrown).toMatchObject({ code: "VGPU-ASYNC-FRAME-CALLBACK", where: "frameLoop" });
  expect(calls).toBe(1);
  expect(submits.count).toBe(0);
  expect(callbacks.size).toBe(0);

  let stopCalls = 0;
  const stop = handle?.stop.bind(handle);
  if (handle) handle.stop = () => { stopCalls += 1; stop?.(); };
  gpu.dispose();
  expect(stopCalls).toBe(0);
});

test("invalid results release telemetry retains and managed-uniform pages", async () => {
  const gpu = await initWithTimestampQuery();
  const destroyed: number[] = [];
  spyQuerySetDestroys(gpu.device.gpu, destroyed);
  const gpuTimer = timer(gpu);
  const vis = visibility(gpu);
  const scene = target(gpu, { size: [4, 4], depth: true });
  const query = vis.query("statue");
  const sim = compute(gpu, prepareShader("@group(0) @binding(0) var<uniform> value: f32; @compute @workgroup_size(1) fn main() { let x = value; }"), { set: { value: 1 } });
  const mock = getMockGPUDeviceInstrumentation(gpu.gpu);
  const erasedCallback: FrameLoopCallback = (currentFrame) => {
    currentFrame.computePass((pass) => pass.dispatch(sim, 1));
    currentFrame.pass({ target: scene, timer: gpuTimer.span("main"), visibility: vis }, (pass) => {
      pass.occlusion(query, () => undefined);
    });
    gpuTimer.dispose();
    vis.dispose();
    expect(destroyed).toEqual([]);
    return Promise.resolve();
  };

  expect(() => frame(gpu, erasedCallback)).toThrow(expect.objectContaining({ code: "VGPU-ASYNC-FRAME-CALLBACK" }));
  expect([...destroyed].sort()).toEqual([0, 1]);

  const allocations = mock.calls.createBuffer;
  const next = frame(gpu, (currentFrame) => currentFrame.computePass((pass) => pass.dispatch(sim, 1)));
  expect(mock.calls.createBuffer).toBe(allocations);
  await next.done;
  gpu.dispose();
});

test("independent submission and async CPU continuation remain while the canceled frame rejects later encoding", async () => {
  const gpu = await init();
  const submits = spyQueueSubmits(gpu.device.gpu);
  const errors: unknown[] = [];
  const unhandled: unknown[] = [];
  const unsubscribe = gpu.onError((error) => { errors.push(error); });
  const onUnhandled = (error: unknown) => { unhandled.push(error); };
  process.on("unhandledRejection", onUnhandled);
  const colorTarget = target(gpu, { size: [4, 4] });
  const independent = effect(gpu, prepareShader("@fragment fn main() -> @location(0) vec4f { return vec4f(1); }"));
  let cpuContinued = false;
  let continuationError: unknown;
  const erasedCallback: FrameLoopCallback = async (currentFrame) => {
    independent.draw(colorTarget);
    currentFrame.pass(colorTarget, () => undefined);
    await Promise.resolve();
    cpuContinued = true;
    try { currentFrame.pass(colorTarget, () => undefined); }
    catch (error) { continuationError = error; throw error; }
  };

  try {
    expect(() => frame(gpu, erasedCallback)).toThrow(expect.objectContaining({ code: "VGPU-ASYNC-FRAME-CALLBACK" }));
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    expect(cpuContinued).toBe(true);
    expect(continuationError).toMatchObject({ code: "VGPU-FRAME-CANCELED", where: "Frame.pass" });
    expect(submits.count).toBe(1);
    expect(unhandled).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    process.off("unhandledRejection", onUnhandled);
    unsubscribe();
    gpu.dispose();
  }
});

test.each([
  ["number", 1],
  ["function", () => undefined],
  ["object with non-callable then", { then: "not callable" }],
])("a synchronous %s result still implicitly submits", async (_kind, value) => {
  const gpu = await init();
  const submits = spyQueueSubmits(gpu.device.gpu);

  const currentFrame = frame(gpu, () => value);

  expect(submits.count).toBe(1);
  await currentFrame.done;
  gpu.dispose();
});

function spyQueueSubmits(device: GPUDevice): { readonly count: number } {
  const counter = { count: 0 };
  const original = device.queue.submit.bind(device.queue);
  vi.spyOn(device.queue, "submit").mockImplementation((buffers: Iterable<GPUCommandBuffer>) => {
    counter.count += 1;
    original(buffers);
  });
  return counter;
}

function initWithTimestampQuery() {
  return init({ adapter: createMockAdapter({ features: ["timestamp-query"] }), requiredFeatures: ["timestamp-query"] });
}

function spyQuerySetDestroys(device: GPUDevice, destroyed: number[]): void {
  let created = 0;
  const originalCreateQuerySet = device.createQuerySet.bind(device);
  vi.spyOn(device, "createQuerySet").mockImplementation((descriptor: GPUQuerySetDescriptor) => {
    const querySet = originalCreateQuerySet(descriptor);
    const index = created++;
    const originalDestroy = querySet.destroy.bind(querySet);
    querySet.destroy = () => { destroyed.push(index); originalDestroy(); };
    return querySet;
  });
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

function fire(callbacks: Map<number, RafCallback>, id: number, timestamp: number): void {
  const callback = callbacks.get(id);
  callbacks.delete(id);
  callback?.(timestamp);
}
