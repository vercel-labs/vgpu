import { afterEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({ init: vi.fn() }));
const sceneFns = vi.hoisted(() => ({
  createScene: vi.fn(),
  renderScene: vi.fn(),
}));
const vgpuFns = vi.hoisted(() => ({
  clock: (gpu: any) => gpu.clock,
  frameLoop: (gpu: any, ...args: any[]) => gpu.fns.frameLoop(...args),
  surface: (gpu: any, ...args: any[]) => gpu.fns.surface(...args),
}));

vi.mock("vgpu", () => ({ init: mocks.init, ...vgpuFns }));
vi.mock("./scene", () => sceneFns);

import { createRenderer } from "./renderer";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function setup() {
  const canvas = {} as HTMLCanvasElement;
  const output = { size: [320, 180] as number[], format: "bgra8unorm" };
  const scene = {
    body: {},
    cap: {},
    geometries: [{ destroy: vi.fn() }, { destroy: vi.fn() }],
  };
  const stop = vi.fn();
  let loopCallback: ((frame: unknown) => void) | undefined;
  const gpu = {
    clock: { time: 2.4, deltaTime: 1 / 60 },
    dispose: vi.fn(),
    fns: {
      surface: vi.fn(() => output),
      frameLoop: vi.fn((callback: (frame: unknown) => void) => {
        loopCallback = callback;
        return { stop };
      }),
    },
  };
  mocks.init.mockResolvedValue(gpu);
  sceneFns.createScene.mockReturnValue(scene);

  return {
    canvas,
    output,
    scene,
    stop,
    gpu,
    get loopCallback() {
      return loopCallback;
    },
  };
}

afterEach(() => {
  vi.resetAllMocks();
});

test("uses the responsive package surface and delegates live VGPU resources to gpu.dispose", async () => {
  const env = setup();
  const renderer = createRenderer(env.canvas);
  await renderer.ready;

  expect(env.gpu.fns.surface).toHaveBeenCalledWith(env.canvas, { dpr: [1, 2] });
  env.output.size = [390, 844];
  env.loopCallback?.({ id: "frame" });
  expect(sceneFns.renderScene).toHaveBeenCalledWith(
    { id: "frame" },
    env.scene,
    env.output,
    2.4
  );

  renderer.dispose();
  renderer.dispose();
  expect(env.stop).toHaveBeenCalledOnce();
  expect(env.gpu.dispose).toHaveBeenCalledOnce();
  expect(env.scene.geometries[0].destroy).not.toHaveBeenCalled();
  expect(env.scene.geometries[1].destroy).not.toHaveBeenCalled();
});

test("quietly disposes a GPU that arrives after intentional cancellation", async () => {
  const env = setup();
  const initializing = deferred<typeof env.gpu>();
  mocks.init.mockReturnValueOnce(initializing.promise);
  env.gpu.dispose.mockImplementationOnce(() => {
    throw new Error("stale GPU cleanup failed");
  });
  const renderer = createRenderer(env.canvas);
  await vi.waitFor(() => expect(mocks.init).toHaveBeenCalledOnce());

  renderer.dispose();
  initializing.resolve(env.gpu);

  await expect(renderer.ready).resolves.toBeUndefined();
  expect(env.gpu.dispose).toHaveBeenCalledOnce();
  expect(env.gpu.fns.surface).not.toHaveBeenCalled();
});

test("quietly finishes scene preparation after immediate browser disposal", async () => {
  const env = setup();
  const preparing = deferred<typeof env.scene>();
  sceneFns.createScene.mockReturnValueOnce(preparing.promise);
  const renderer = createRenderer(env.canvas);
  await vi.waitFor(() => expect(sceneFns.createScene).toHaveBeenCalledOnce());

  renderer.dispose();
  preparing.resolve(env.scene);

  await expect(renderer.ready).resolves.toBeUndefined();
  expect(env.gpu.dispose).toHaveBeenCalledOnce();
  expect(env.gpu.fns.frameLoop).not.toHaveBeenCalled();
  expect(env.scene.geometries[0].destroy).not.toHaveBeenCalled();
});

test("tears down and rethrows the identical live frame failure", async () => {
  const env = setup();
  const renderer = createRenderer(env.canvas);
  await renderer.ready;
  const failure = new Error("live frame failed");
  sceneFns.renderScene.mockImplementationOnce(() => {
    throw failure;
  });

  expect(() => env.loopCallback?.({})).toThrow(failure);
  expect(env.stop).toHaveBeenCalledOnce();
  expect(env.gpu.dispose).toHaveBeenCalledOnce();
});

test("rejects with the exact scene failure after browser-owner teardown", async () => {
  const env = setup();
  const failure = new Error("scene failed");
  sceneFns.createScene.mockImplementationOnce(() => {
    throw failure;
  });
  const renderer = createRenderer(env.canvas);

  await expect(renderer.ready).rejects.toBe(failure);
  expect(env.gpu.dispose).toHaveBeenCalledOnce();
  expect(env.gpu.fns.frameLoop).not.toHaveBeenCalled();
});

test("rejects with the exact initialization failure before allocating browser state", async () => {
  const env = setup();
  const failure = new Error("WebGPU initialization failed");
  mocks.init.mockRejectedValueOnce(failure);
  const renderer = createRenderer(env.canvas);

  await expect(renderer.ready).rejects.toBe(failure);
  expect(env.gpu.fns.surface).not.toHaveBeenCalled();
  expect(env.gpu.dispose).not.toHaveBeenCalled();
});

test("rejects with the exact surface setup failure and tears down", async () => {
  const env = setup();
  const failure = new Error("surface setup failed");
  env.gpu.fns.surface.mockImplementationOnce(() => {
    throw failure;
  });
  const renderer = createRenderer(env.canvas);

  await expect(renderer.ready).rejects.toBe(failure);
  expect(env.gpu.dispose).toHaveBeenCalledOnce();
  expect(sceneFns.createScene).not.toHaveBeenCalled();
});

test("runs every public cleanup while preserving the first error", async () => {
  const env = setup();
  const renderer = createRenderer(env.canvas);
  await renderer.ready;
  const failure = new Error("loop stop failed");
  env.stop.mockImplementationOnce(() => {
    throw failure;
  });
  env.gpu.dispose.mockImplementationOnce(() => {
    throw new Error("GPU cleanup failed");
  });

  expect(() => renderer.dispose()).toThrow(failure);
  expect(env.stop).toHaveBeenCalledOnce();
  expect(env.gpu.dispose).toHaveBeenCalledOnce();
  expect(() => renderer.dispose()).not.toThrow();
});
