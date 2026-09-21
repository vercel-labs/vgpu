import { afterEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  init: vi.fn(),
  createFluid: vi.fn(() => ({ marker: "fluid" })),
  destroyFluid: vi.fn(),
  prepareFluid: vi.fn(async () => {}),
  renderFluid: vi.fn(),
  resizeFluid: vi.fn(),
  stepFluid: vi.fn(),
  inputDispose: vi.fn(),
}));

vi.mock("vgpu", () => ({
  init: mocks.init,
  surface: (gpu: any, ...args: any[]) => gpu.surface(...args),
}));
vi.mock("./simulation", () => ({
  createFluid: mocks.createFluid,
  destroyFluid: mocks.destroyFluid,
  prepareFluid: mocks.prepareFluid,
  renderFluid: mocks.renderFluid,
  resizeFluid: mocks.resizeFluid,
  stepFluid: mocks.stepFluid,
}));
vi.mock("./pointer-input", () => ({
  installStirInput: () => ({ dispose: mocks.inputDispose }),
}));

import { renderThumbnail } from "./render-thumbnail";
import { createRenderer } from "./renderer";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function setup() {
  let nextRaf = 1;
  const callbacks = new Map<number, FrameRequestCallback>();
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn((callback: FrameRequestCallback) => {
      const id = nextRaf++;
      callbacks.set(id, callback);
      return id;
    })
  );
  vi.stubGlobal(
    "cancelAnimationFrame",
    vi.fn((id: number) => callbacks.delete(id))
  );
  vi.stubGlobal("performance", { now: () => 0 });
  const page = { hidden: false };
  vi.stubGlobal("document", page);

  let surfaceResizeCallback: (() => void) | undefined;
  const surface = {
    onResize: vi.fn((callback: () => void) => {
      surfaceResizeCallback = callback;
      callback();
      return vi.fn();
    }),
    dispose: vi.fn(),
    size: [100, 50],
    format: "bgra8unorm",
  };
  const gpu = { dispose: vi.fn(), surface: vi.fn(() => surface) };
  mocks.init.mockResolvedValueOnce(gpu);
  const canvas = { style: { touchAction: "" } } as unknown as HTMLCanvasElement;

  const fireNext = (time: number) => {
    const entry = callbacks.entries().next().value as
      | [number, FrameRequestCallback]
      | undefined;
    if (!entry) return;
    callbacks.delete(entry[0]);
    entry[1](time);
  };

  return {
    page,
    surface,
    gpu,
    canvas,
    callbacks,
    fireNext,
    surfaceResize: () => surfaceResizeCallback?.(),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

test("hidden time is discarded and owned GPU disposal cancels future work", async () => {
  const env = setup();
  const renderer = createRenderer({ canvas: env.canvas });
  await renderer.ready;

  env.fireNext(17);
  expect(mocks.stepFluid).toHaveBeenCalledOnce();
  env.page.hidden = true;
  env.fireNext(10_000);
  expect(mocks.stepFluid).toHaveBeenCalledOnce();
  env.page.hidden = false;
  env.fireNext(10_017);
  expect(mocks.stepFluid).toHaveBeenCalledTimes(2);

  renderer.dispose();
  renderer.dispose();
  expect(env.callbacks.size).toBe(0);
  expect(mocks.inputDispose).toHaveBeenCalledOnce();
  expect(env.gpu.dispose).toHaveBeenCalledOnce();
  expect(env.surface.dispose).not.toHaveBeenCalled();
  expect(mocks.destroyFluid).not.toHaveBeenCalled();
});

test("surface resize only refreshes size-dependent display bindings", async () => {
  const env = setup();
  const renderer = createRenderer({ canvas: env.canvas });
  await renderer.ready;
  expect(mocks.prepareFluid).toHaveBeenCalledOnce();
  expect(mocks.resizeFluid).toHaveBeenCalledOnce();

  env.surfaceResize();
  env.surfaceResize();
  env.surfaceResize();
  expect(mocks.resizeFluid).toHaveBeenCalledTimes(4);
  expect(mocks.prepareFluid).toHaveBeenCalledOnce();
  expect(env.callbacks.size).toBe(1);
  renderer.dispose();
});

test("resize binding failure stops animation and tears down ownership", async () => {
  const env = setup();
  const renderer = createRenderer({ canvas: env.canvas });
  await renderer.ready;
  const failure = new Error("resize failed");
  mocks.resizeFluid.mockImplementationOnce(() => {
    throw failure;
  });

  expect(env.surfaceResize).toThrow(failure);
  expect(env.callbacks.size).toBe(0);
  expect(mocks.inputDispose).toHaveBeenCalledOnce();
  expect(env.gpu.dispose).toHaveBeenCalledOnce();
});

test("thumbnail cleanup waits for both shared-GPU barriers before releasing resources", async () => {
  const failure = new Error("compile failed");
  mocks.prepareFluid.mockRejectedValueOnce(failure);
  const submitted = deferred<void>();
  const settled = deferred<void>();
  const onSubmittedWorkDone = vi.fn(() => submitted.promise);
  const gpu = {
    gpu: { queue: { onSubmittedWorkDone } },
    settled: vi.fn(() => settled.promise),
  };
  const rendering = renderThumbnail(gpu as never, {} as never);

  await vi.waitFor(() => {
    expect(onSubmittedWorkDone).toHaveBeenCalledOnce();
    expect(gpu.settled).toHaveBeenCalledOnce();
  });
  expect(mocks.destroyFluid).not.toHaveBeenCalled();

  submitted.resolve();
  await Promise.resolve();
  expect(mocks.destroyFluid).not.toHaveBeenCalled();

  settled.resolve();
  await expect(rendering).rejects.toBe(failure);
  expect(mocks.destroyFluid).toHaveBeenCalledOnce();
});

test("thumbnail cleanup survives rejected barriers without replacing the primary error", async () => {
  const failure = new Error("compile failed");
  const drainFailure = new Error("drain failed");
  const settleFailure = new Error("settle failed");
  mocks.prepareFluid.mockRejectedValueOnce(failure);
  const onSubmittedWorkDone = vi.fn(() => {
    throw drainFailure;
  });
  const gpu = {
    gpu: { queue: { onSubmittedWorkDone } },
    settled: vi.fn(() => Promise.reject(settleFailure)),
  };

  await expect(renderThumbnail(gpu as never, {} as never)).rejects.toBe(
    failure
  );
  expect(onSubmittedWorkDone).toHaveBeenCalledOnce();
  expect(gpu.settled).toHaveBeenCalledOnce();
  expect(mocks.destroyFluid).toHaveBeenCalledOnce();
});

test("initialization failure preserves the error and tears down external ownership", async () => {
  const env = setup();
  const failure = new Error("compile failed");
  mocks.prepareFluid.mockRejectedValueOnce(failure);

  const renderer = createRenderer({ canvas: env.canvas });
  await expect(renderer.ready).rejects.toBe(failure);

  expect(mocks.inputDispose).toHaveBeenCalledOnce();
  expect(env.gpu.dispose).toHaveBeenCalledOnce();
  expect(env.surface.dispose).not.toHaveBeenCalled();
  expect(mocks.destroyFluid).not.toHaveBeenCalled();
  expect(env.callbacks.size).toBe(0);
});

test("dispose during async preparation ignores the stale completion", async () => {
  const env = setup();
  let release!: () => void;
  mocks.prepareFluid.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      })
  );
  const renderer = createRenderer({ canvas: env.canvas });
  await vi.waitFor(() => expect(mocks.prepareFluid).toHaveBeenCalledOnce());

  renderer.dispose();
  release();
  await renderer.ready;

  expect(env.gpu.dispose).toHaveBeenCalledOnce();
  expect(env.surface.onResize).not.toHaveBeenCalled();
  expect(env.callbacks.size).toBe(0);
});

test("dispose before GPU readiness prevents installation and disposes the late GPU", async () => {
  const env = setup();
  let resolve!: (gpu: typeof env.gpu) => void;
  mocks.init.mockReset().mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    })
  );
  const renderer = createRenderer({ canvas: env.canvas });
  await vi.waitFor(() => expect(mocks.init).toHaveBeenCalledOnce());

  renderer.dispose();
  resolve(env.gpu);
  await renderer.ready;

  expect(env.gpu.dispose).toHaveBeenCalledOnce();
  expect(env.gpu.surface).not.toHaveBeenCalled();
  expect(env.callbacks.size).toBe(0);
});
