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
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function setup() {
  const canvas = {} as HTMLCanvasElement;
  const output = { size: [320, 180] };
  const scene = { solid: {} };
  const stop = vi.fn();
  let loopCallback: ((frame: unknown) => void) | undefined;
  const gpu = {
    clock: { time: 3.1 },
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

afterEach(() => vi.resetAllMocks());

test("renders through the responsive surface and disposes idempotently", async () => {
  const env = setup();
  const renderer = createRenderer(env.canvas);
  await renderer.ready;

  expect(env.gpu.fns.surface).toHaveBeenCalledWith(env.canvas, { dpr: [1, 2] });
  env.loopCallback?.({ id: "frame" });
  expect(sceneFns.renderScene).toHaveBeenCalledWith(
    { id: "frame" },
    env.scene,
    env.output,
    3.1
  );

  renderer.dispose();
  renderer.dispose();
  expect(env.stop).toHaveBeenCalledOnce();
  expect(env.gpu.dispose).toHaveBeenCalledOnce();
});

test("disposes a GPU that arrives after intentional cancellation", async () => {
  const env = setup();
  const initializing = deferred<typeof env.gpu>();
  mocks.init.mockReturnValueOnce(initializing.promise);
  const renderer = createRenderer(env.canvas);
  await vi.waitFor(() => expect(mocks.init).toHaveBeenCalledOnce());

  renderer.dispose();
  initializing.resolve(env.gpu);

  await expect(renderer.ready).resolves.toBeUndefined();
  expect(env.gpu.dispose).toHaveBeenCalledOnce();
  expect(env.gpu.fns.surface).not.toHaveBeenCalled();
});

test("preserves initialization failures before browser allocation", async () => {
  const env = setup();
  const failure = new Error("WebGPU initialization failed");
  mocks.init.mockRejectedValueOnce(failure);
  const renderer = createRenderer(env.canvas);

  await expect(renderer.ready).rejects.toBe(failure);
  expect(env.gpu.fns.surface).not.toHaveBeenCalled();
  expect(env.gpu.dispose).not.toHaveBeenCalled();
});

test("tears down after surface or scene setup failures", async () => {
  const surfaceEnv = setup();
  const surfaceFailure = new Error("surface setup failed");
  surfaceEnv.gpu.fns.surface.mockImplementationOnce(() => {
    throw surfaceFailure;
  });
  await expect(createRenderer(surfaceEnv.canvas).ready).rejects.toBe(surfaceFailure);
  expect(surfaceEnv.gpu.dispose).toHaveBeenCalledOnce();

  const sceneEnv = setup();
  const sceneFailure = new Error("scene setup failed");
  sceneFns.createScene.mockImplementationOnce(() => {
    throw sceneFailure;
  });
  await expect(createRenderer(sceneEnv.canvas).ready).rejects.toBe(sceneFailure);
  expect(sceneEnv.gpu.dispose).toHaveBeenCalledOnce();
});

test("stops and disposes on a live frame failure", async () => {
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

test("runs every cleanup while preserving the first failure", async () => {
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
