import { afterEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({ init: vi.fn() }));
const sceneFns = vi.hoisted(() => ({
  createBlit: vi.fn(),
  createScene: vi.fn(),
  renderScene: vi.fn(),
}));
const vgpuFns = vi.hoisted(() => ({
  clock: (gpu: any) => gpu.clock,
  frameLoop: (gpu: any, ...args: any[]) => gpu.fns.frameLoop(...args),
  surface: (gpu: any, ...args: any[]) => gpu.fns.surface(...args),
  target: (gpu: any, ...args: any[]) => gpu.fns.target(...args),
}));

vi.mock("vgpu", () => ({ init: mocks.init, ...vgpuFns }));
vi.mock("./scene-pipeline", () => sceneFns);

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
  const canvas = {
    getBoundingClientRect: () => ({ width: 320, height: 180 }),
  } as HTMLCanvasElement;
  const unsubscribeResize = vi.fn();
  let resizeCallback:
    | ((event: { width: number; height: number; dpr: number }) => void)
    | undefined;
  const canvasSurface = {
    size: [320, 180] as number[],
    format: "bgra8unorm",
    onResize: vi.fn((callback: typeof resizeCallback) => {
      resizeCallback = callback;
      callback?.({ width: 320, height: 180, dpr: 1 });
      return unsubscribeResize;
    }),
    dispose: vi.fn(),
  };
  const targets: { size: number[]; destroy: ReturnType<typeof vi.fn> }[] = [];
  const blits: {
    compile: ReturnType<typeof vi.fn>;
    compileSync: ReturnType<typeof vi.fn>;
  }[] = [];
  const compileResults: unknown[] = [];
  const syncCompileResults: unknown[] = [];
  const scene = { geometry: { destroy: vi.fn() }, draws: [], bundle: {} };
  const stop = vi.fn();
  let loopCallback: ((frame: unknown) => void) | undefined;
  const gpu = {
    clock: { time: 2.4, deltaTime: 1 / 60 },
    dispose: vi.fn(),
    fns: {
      surface: vi.fn(() => canvasSurface),
      target: vi.fn((options: { size: readonly number[] }) => {
        const value = { size: [...options.size], destroy: vi.fn() };
        targets.push(value);
        return value;
      }),
      frameLoop: vi.fn((callback: (frame: unknown) => void) => {
        loopCallback = callback;
        return { stop };
      }),
    },
  };
  sceneFns.createScene.mockResolvedValue(scene);
  sceneFns.createBlit.mockImplementation(() => {
    const useResult = (results: unknown[], fallback: unknown) => {
      const result = results.shift();
      return typeof result === "function" ? result() : result ?? fallback;
    };
    const blit = {
      compile: vi.fn(() => useResult(compileResults, Promise.resolve(blit))),
      compileSync: vi.fn(() => useResult(syncCompileResults, blit)),
    };
    blits.push(blit);
    return blit;
  });
  mocks.init.mockResolvedValue(gpu);

  const triggerResize = (width: number, height: number, dpr = 1) => {
    canvasSurface.size = [width, height];
    resizeCallback?.({ width, height, dpr });
  };

  return {
    canvas,
    canvasSurface,
    unsubscribeResize,
    targets,
    blits,
    compileResults,
    syncCompileResults,
    scene,
    stop,
    gpu,
    triggerResize,
    get loopCallback() {
      return loopCallback;
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

test("releases superseded resize targets but leaves the active target to gpu.dispose", async () => {
  const env = setup();
  const renderer = createRenderer({ canvas: env.canvas });
  await renderer.ready;

  expect(env.gpu.fns.surface).toHaveBeenCalledWith(env.canvas, { dpr: [1, 2] });
  env.triggerResize(1000, 500, 2);

  expect(env.targets).toHaveLength(2);
  expect(env.targets[1]?.size).toEqual([1000, 500]);
  expect(sceneFns.createBlit).toHaveBeenLastCalledWith(
    env.gpu,
    env.targets[1],
    env.canvasSurface
  );
  expect(env.targets[0]?.destroy).toHaveBeenCalledOnce();
  expect(env.targets[1]?.destroy).not.toHaveBeenCalled();

  env.triggerResize(600, 900, 1.5);
  expect(env.targets).toHaveLength(3);
  expect(env.targets[0]?.destroy).toHaveBeenCalledOnce();
  expect(env.targets[1]?.destroy).toHaveBeenCalledOnce();
  expect(env.targets[2]?.destroy).not.toHaveBeenCalled();

  env.loopCallback?.({});
  expect(sceneFns.renderScene).toHaveBeenLastCalledWith(
    {},
    env.scene,
    env.blits[2],
    env.targets[2],
    env.canvasSurface,
    2.4
  );

  renderer.dispose();
  renderer.dispose();
  expect(env.stop).toHaveBeenCalledOnce();
  expect(env.unsubscribeResize).toHaveBeenCalledOnce();
  expect(env.gpu.dispose).toHaveBeenCalledOnce();
  expect(env.canvasSurface.dispose).not.toHaveBeenCalled();
  expect(env.scene.geometry.destroy).not.toHaveBeenCalled();
  expect(env.targets[0]?.destroy).toHaveBeenCalledOnce();
  expect(env.targets[1]?.destroy).toHaveBeenCalledOnce();
  expect(env.targets[2]?.destroy).not.toHaveBeenCalled();
});

test("rolls back a failed resize candidate without retiring the active target", async () => {
  const env = setup();
  const renderer = createRenderer({ canvas: env.canvas });
  await renderer.ready;
  const failed = new Error("rebind failed");
  env.syncCompileResults.push(() => {
    throw failed;
  });

  expect(() => env.triggerResize(1000, 500, 2)).toThrow(failed);

  expect(env.gpu.dispose).toHaveBeenCalledOnce();
  expect(env.stop).toHaveBeenCalledOnce();
  expect(env.targets[0]?.destroy).not.toHaveBeenCalled();
  expect(env.targets[1]?.destroy).toHaveBeenCalledOnce();
});

test("preserves a retired-target cleanup failure after committing the candidate", async () => {
  const env = setup();
  const renderer = createRenderer({ canvas: env.canvas });
  await renderer.ready;
  const failed = new Error("retired target cleanup failed");
  env.targets[0]?.destroy.mockImplementationOnce(() => {
    throw failed;
  });

  expect(() => env.triggerResize(1000, 500, 2)).toThrow(failed);

  expect(env.targets).toHaveLength(2);
  expect(env.targets[0]?.destroy).toHaveBeenCalledOnce();
  expect(env.targets[1]?.destroy).not.toHaveBeenCalled();
  expect(env.gpu.dispose).toHaveBeenCalledOnce();
  expect(env.stop).toHaveBeenCalledOnce();
});

test("tears down and rethrows the identical frame failure", async () => {
  const env = setup();
  const renderer = createRenderer({ canvas: env.canvas });
  await renderer.ready;
  const failed = new Error("frame failed");
  sceneFns.renderScene.mockImplementationOnce(() => {
    throw failed;
  });

  expect(() => env.loopCallback?.({})).toThrow(failed);
  expect(env.gpu.dispose).toHaveBeenCalledOnce();
  expect(env.stop).toHaveBeenCalledOnce();
});

test("waits for all initial preparation before rejecting and rolling back", async () => {
  const env = setup();
  const failed = new Error("scene preparation failed");
  const scene = deferred<never>();
  const blit = deferred<unknown>();
  sceneFns.createScene.mockReturnValueOnce(scene.promise);
  env.compileResults.push(blit.promise);
  const renderer = createRenderer({ canvas: env.canvas });
  const rejected = expect(renderer.ready).rejects.toBe(failed);

  await vi.waitFor(() => {
    expect(sceneFns.createScene).toHaveBeenCalledOnce();
    expect(env.blits[0]?.compile).toHaveBeenCalledOnce();
  });
  scene.reject(failed);
  await Promise.resolve();
  expect(env.gpu.dispose).not.toHaveBeenCalled();
  blit.resolve({});

  await rejected;
  expect(env.gpu.dispose).toHaveBeenCalledOnce();
  expect(env.gpu.fns.frameLoop).not.toHaveBeenCalled();
});

test("promise-wraps a synchronous initial compile throw", async () => {
  const env = setup();
  const failed = new Error("sync compile failed");
  env.compileResults.push(() => {
    throw failed;
  });
  const renderer = createRenderer({ canvas: env.canvas });

  await expect(renderer.ready).rejects.toBe(failed);
  expect(sceneFns.createScene).toHaveBeenCalledOnce();
  expect(env.gpu.dispose).toHaveBeenCalledOnce();
});

test("quietly disposes a GPU that arrives after intentional cancellation", async () => {
  const env = setup();
  const initializing = deferred<typeof env.gpu>();
  mocks.init.mockReturnValueOnce(initializing.promise);
  env.gpu.dispose.mockImplementationOnce(() => {
    throw new Error("stale cleanup failed");
  });
  const renderer = createRenderer({ canvas: env.canvas });
  await vi.waitFor(() => expect(mocks.init).toHaveBeenCalledOnce());
  renderer.dispose();
  initializing.resolve(env.gpu);

  await expect(renderer.ready).resolves.toBeUndefined();
  expect(env.gpu.dispose).toHaveBeenCalledOnce();
  expect(env.gpu.fns.surface).not.toHaveBeenCalled();
});

test("quietly finishes scene preparation after browser disposal", async () => {
  const env = setup();
  const preparingScene = deferred<typeof env.scene>();
  sceneFns.createScene.mockReturnValueOnce(preparingScene.promise);
  const renderer = createRenderer({ canvas: env.canvas });
  await vi.waitFor(() => expect(sceneFns.createScene).toHaveBeenCalledOnce());
  renderer.dispose();
  preparingScene.resolve(env.scene);

  await expect(renderer.ready).resolves.toBeUndefined();
  expect(env.gpu.dispose).toHaveBeenCalledOnce();
  expect(env.gpu.fns.frameLoop).not.toHaveBeenCalled();
  expect(env.scene.geometry.destroy).not.toHaveBeenCalled();
});

test("tears down after synchronous initial target allocation failure", async () => {
  const env = setup();
  const failed = new Error("target allocation failed");
  env.gpu.fns.target.mockImplementationOnce(() => {
    throw failed;
  });
  const renderer = createRenderer({ canvas: env.canvas });

  await expect(renderer.ready).rejects.toBe(failed);
  expect(sceneFns.createBlit).not.toHaveBeenCalled();
  expect(env.gpu.dispose).toHaveBeenCalledOnce();
});

test("runs every cleanup while preserving the first public dispose error", async () => {
  const env = setup();
  const renderer = createRenderer({ canvas: env.canvas });
  await renderer.ready;
  const failed = new Error("stop failed");
  env.stop.mockImplementationOnce(() => {
    throw failed;
  });

  expect(() => renderer.dispose()).toThrow(failed);
  expect(env.unsubscribeResize).toHaveBeenCalledOnce();
  expect(env.gpu.dispose).toHaveBeenCalledOnce();
  expect(() => renderer.dispose()).not.toThrow();
});
