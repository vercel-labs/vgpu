import { prepareShader } from "@vgpu/wgsl/prepare";
import { afterEach, expect, test, vi } from "vitest";
import { createMockGPUDevice } from "@vgpu/core";
import { compute, draw, frame, init, initFromDevice, target, VGPUError } from "../src/mock.ts";
import { submittedWorkDone } from "../src/claim-validation.ts";
import { kernelOf } from "../src/kernel.ts";

const SHADER = `
@vertex fn vs(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  let positions = array(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
  return vec4f(positions[index], 0, 1);
}
@fragment fn fs() -> @location(0) vec4f { return vec4f(1); }
`;

afterEach(() => vi.restoreAllMocks());

test("settled captures a queue fence synchronously and waits for a plain draw", async () => {
  const gpu = await init();
  const fence = deferred<undefined>();
  const onSubmittedWorkDone = vi.spyOn(gpu.gpu.queue, "onSubmittedWorkDone").mockReturnValue(fence.promise);

  try {
    draw(gpu, { shader: prepareShader(SHADER) }).draw(target(gpu, { size: [4, 4] }));

    let complete = false;
    const settled = gpu.settled().then(() => { complete = true; });

    expect(onSubmittedWorkDone).toHaveBeenCalledOnce();
    await nextTurn();
    expect(complete).toBe(false);

    fence.resolve(undefined);
    await settled;
    expect(complete).toBe(true);
  } finally {
    fence.resolve(undefined);
    gpu.dispose();
  }
});

test("settled does not extend its snapshot to later submissions or pipeline work", async () => {
  const gpu = await init();
  const colorTarget = target(gpu, { size: [4, 4] });
  const drawable = draw(gpu, { shader: prepareShader(SHADER) });
  await gpu.settled();
  const fence = deferred<undefined>();
  const pipeline = deferred<GPURenderPipeline>();
  const onSubmittedWorkDone = vi.spyOn(gpu.gpu.queue, "onSubmittedWorkDone").mockReturnValue(fence.promise);
  vi.spyOn(gpu.gpu, "createRenderPipelineAsync").mockReturnValue(pipeline.promise);

  try {
    const settled = gpu.settled();
    expect(onSubmittedWorkDone).toHaveBeenCalledOnce();

    gpu.gpu.queue.submit([]);
    let compiled = false;
    const compilation = drawable.compile(colorTarget).then((value) => {
      compiled = true;
      return value;
    });

    fence.resolve(undefined);
    await settled;
    expect(compiled).toBe(false);

    pipeline.resolve({} as GPURenderPipeline);
    await compilation;
  } finally {
    fence.resolve(undefined);
    pipeline.resolve({} as GPURenderPipeline);
    gpu.dispose();
  }
});

test.each(["delivery", "source"] as const)("an already-lost device retains existing waits when the %s resolves first", async (first) => {
  const { device, lose } = losableDevice();
  const gpu = await initFromDevice(device);
  const delivery = deferred<void>();
  const source = deferred<void>();
  const kernel = kernelOf(gpu);
  void kernel.trackDelivery(delivery.promise);
  const release = kernel.registerSettledSource(() => [source.promise]);
  const onSubmittedWorkDone = vi.spyOn(device.queue, "onSubmittedWorkDone");

  try {
    lose();
    await Promise.resolve();

    let complete = false;
    const settled = gpu.settled().then(() => { complete = true; });
    expect(onSubmittedWorkDone).not.toHaveBeenCalled();
    await nextTurn();
    expect(complete).toBe(false);

    if (first === "delivery") delivery.resolve();
    else source.resolve();
    await nextTurn();
    expect(complete).toBe(false);
    if (first === "delivery") source.resolve();
    else delivery.resolve();
    await settled;
    expect(complete).toBe(true);
  } finally {
    delivery.resolve();
    source.resolve();
    release();
    gpu.dispose();
  }
});

test("an already-disposed gpu skips a new fence but retains existing deliveries", async () => {
  const gpu = await init();
  const delivery = deferred<void>();
  void kernelOf(gpu).trackDelivery(delivery.promise);
  const onSubmittedWorkDone = vi.spyOn(gpu.gpu.queue, "onSubmittedWorkDone");
  gpu.dispose();

  let complete = false;
  const settled = gpu.settled().then(() => { complete = true; });
  expect(onSubmittedWorkDone).not.toHaveBeenCalled();
  await nextTurn();
  expect(complete).toBe(false);

  delivery.resolve();
  await settled;
});

test("dispose after capture does not release the queue fence early", async () => {
  const gpu = await init();
  const fence = deferred<undefined>();
  const onSubmittedWorkDone = vi.spyOn(gpu.gpu.queue, "onSubmittedWorkDone").mockReturnValue(fence.promise);

  const settled = pendingState(gpu.settled());
  expect(onSubmittedWorkDone).toHaveBeenCalledOnce();
  gpu.dispose();
  await nextTurn();
  expect(settled.complete()).toBe(false);

  fence.resolve(undefined);
  await settled.promise;
});

test("loss after capture does not release the queue fence early", async () => {
  const { device, lose } = losableDevice();
  const gpu = await initFromDevice(device);
  const fence = deferred<undefined>();
  const onSubmittedWorkDone = vi.spyOn(device.queue, "onSubmittedWorkDone").mockReturnValue(fence.promise);

  try {
    const settled = pendingState(gpu.settled());
    expect(onSubmittedWorkDone).toHaveBeenCalledOnce();
    lose();
    await nextTurn();
    expect(settled.complete()).toBe(false);

    fence.resolve(undefined);
    await settled.promise;
  } finally {
    fence.resolve(undefined);
    gpu.dispose();
  }
});

test("submittedWorkDone converts a synchronous native throw into an observable rejection", async () => {
  const gpu = await init();
  const nativeError = new Error("synchronous fence failure");
  vi.spyOn(gpu.gpu.queue, "onSubmittedWorkDone").mockImplementation(() => { throw nativeError; });
  let completion: Promise<void> | undefined;

  try {
    expect(() => { completion = submittedWorkDone(gpu.device); }).not.toThrow();
    await expect(completion).rejects.toBe(nativeError);
  } finally {
    gpu.dispose();
  }
});

test.each(["throw", "reject"] as const)("settled fulfills when the queue fence %ss without reporting an error", async (failure) => {
  const gpu = await init();
  const nativeError = new Error(`${failure} fence failure`);
  const errors: unknown[] = [];
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  gpu.onError((error) => errors.push(error));
  process.on("unhandledRejection", onUnhandled);
  if (failure === "throw") {
    vi.spyOn(gpu.gpu.queue, "onSubmittedWorkDone").mockImplementation(() => { throw nativeError; });
  } else {
    vi.spyOn(gpu.gpu.queue, "onSubmittedWorkDone").mockRejectedValue(nativeError);
  }

  try {
    await expect(gpu.settled()).resolves.toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(errors).toEqual([]);
    expect(unhandled).toEqual([]);
  } finally {
    process.off("unhandledRejection", onUnhandled);
    gpu.dispose();
  }
});

test("settled fulfills when a mock omits onSubmittedWorkDone", async () => {
  const gpu = await init();
  Object.defineProperty(gpu.gpu.queue, "onSubmittedWorkDone", { configurable: true, value: undefined });
  try {
    await expect(gpu.settled()).resolves.toBeUndefined();
  } finally {
    gpu.dispose();
  }
});

test("compute dispatch reports a synchronous queue-completion throw exactly once", async () => {
  const gpu = await init();
  const simulation = compute(gpu, prepareShader("@compute @workgroup_size(1) fn main() {}"), { label: "syncFenceDispatch" });
  const nativeError = new Error("synchronous compute fence failure");
  const errors: unknown[] = [];
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  gpu.onError((error) => errors.push(error));
  process.on("unhandledRejection", onUnhandled);
  vi.spyOn(gpu.gpu.queue, "onSubmittedWorkDone").mockImplementation(() => { throw nativeError; });

  try {
    expect(() => simulation.dispatch(1)).not.toThrow();
    await gpu.settled();
    await nextTurn();
    expect(errors).toEqual([
      expect.objectContaining({
        code: "VGPU-COMPUTE-VALIDATION",
        where: "syncFenceDispatch.completion",
        cause: nativeError,
      }),
    ]);
    expect(unhandled).toEqual([]);
  } finally {
    process.off("unhandledRejection", onUnhandled);
    gpu.dispose();
  }
});

test("settled fulfills when a settled source throws without reporting an error", async () => {
  const gpu = await init();
  const errors: unknown[] = [];
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  const release = kernelOf(gpu).registerSettledSource(() => { throw new Error("broken settled source"); });
  gpu.onError((error) => errors.push(error));
  process.on("unhandledRejection", onUnhandled);

  try {
    await expect(gpu.settled()).resolves.toBeUndefined();
    await nextTurn();
    expect(errors).toEqual([]);
    expect(unhandled).toEqual([]);
  } finally {
    process.off("unhandledRejection", onUnhandled);
    release();
    gpu.dispose();
  }
});

test("settled waits for a captured source through its associated error delivery", async () => {
  const gpu = await init();
  const source = deferred<void>();
  const errors: unknown[] = [];
  const kernel = kernelOf(gpu);
  const error = new VGPUError({ code: "VGPU-TEST-SOURCE", message: "source failed", where: "test" });
  const release = kernel.registerSettledSource(() => [source.promise.then(() => kernel.reportError(error))]);
  gpu.onError((reported) => errors.push(reported));

  try {
    const settled = pendingState(gpu.settled());
    await nextTurn();
    expect(settled.complete()).toBe(false);

    source.resolve();
    await settled.promise;
    expect(errors).toEqual([error]);
  } finally {
    source.resolve();
    release();
    gpu.dispose();
  }
});

test("settled does not wait for an open manual frame or the native lost promise", async () => {
  const { device } = losableDevice();
  const gpu = await initFromDevice(device);
  const pending = frame(gpu);

  try {
    await expect(gpu.settled()).resolves.toBeUndefined();
  } finally {
    pending.cancel();
    gpu.dispose();
  }
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function pendingState<T>(promise: Promise<T>) {
  let complete = false;
  return {
    promise: promise.finally(() => { complete = true; }),
    complete: () => complete,
  };
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function losableDevice() {
  let resolveLost!: (info: GPUDeviceLostInfo) => void;
  const device = Object.assign(createMockGPUDevice(), {
    lost: new Promise<GPUDeviceLostInfo>((resolve) => { resolveLost = resolve; }),
    destroy: vi.fn(),
  });
  return {
    device,
    lose: () => resolveLost({ reason: "destroyed", message: "test loss" } as GPUDeviceLostInfo),
  };
}
