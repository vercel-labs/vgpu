import { afterEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createScene: vi.fn(),
  destroyScene: vi.fn(),
  init: vi.fn(),
  prepareScene: vi.fn(async () => {}),
  presentScene: vi.fn(),
  renderLighting: vi.fn(),
  surface: vi.fn(),
}));

const guiMocks = vi.hoisted(() => ({
  construct: vi.fn(),
  controllers: new Map<
    string,
    {
      change?: () => void;
      object: Record<string, unknown>;
      options: ReturnType<typeof vi.fn<(options: unknown) => void>>;
    }
  >(),
  destroy: vi.fn(),
}));

vi.mock("vgpu", () => ({ init: mocks.init, surface: mocks.surface }));
vi.mock("./simulation", () => ({
  createScene: mocks.createScene,
  destroyScene: mocks.destroyScene,
  prepareScene: mocks.prepareScene,
  presentScene: mocks.presentScene,
  renderLighting: mocks.renderLighting,
  scaledSize(width: number, height: number, scale: number, maxEdge: number) {
    const resolved = Math.min(scale, maxEdge / Math.max(width, height, 1));
    return [
      Math.max(1, Math.round(width * resolved)),
      Math.max(1, Math.round(height * resolved)),
    ];
  },
}));
vi.mock("lil-gui", () => ({
  default: class MockGui {
    domElement = { style: {} };

    constructor(options: unknown) {
      guiMocks.construct(options);
    }

    add(object: Record<string, unknown>, property: string) {
      const state = {
        object,
        options: vi.fn<(options: unknown) => void>(),
      } as {
        change?: () => void;
        object: Record<string, unknown>;
        options: ReturnType<typeof vi.fn<(options: unknown) => void>>;
      };
      const controller = {
        name: vi.fn(() => controller),
        onChange: vi.fn((change: () => void) => {
          state.change = change;
          return controller;
        }),
        options: vi.fn((options: unknown) => {
          state.options(options);
          return controller;
        }),
      };
      guiMocks.controllers.set(property, state);
      return controller;
    }

    destroy() {
      guiMocks.destroy();
    }
  },
}));

import { renderThumbnail } from "./render-thumbnail";
import { createRenderer } from "./renderer";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, reject, resolve };
}

function setup() {
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  vi.stubGlobal("document", { hidden: false });
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn((callback: FrameRequestCallback) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    })
  );
  vi.stubGlobal(
    "cancelAnimationFrame",
    vi.fn((id: number) => frames.delete(id))
  );
  const disconnect = vi.fn();
  let observerCallback: ResizeObserverCallback | undefined;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: ResizeObserverCallback) {
        observerCallback = callback;
      }
      observe = vi.fn();
      disconnect = disconnect;
    }
  );

  const container = {} as HTMLElement;
  let width = 200;
  let height = 100;
  const canvas = {
    parentElement: container,
    getBoundingClientRect: () => ({ width, height }),
  } as unknown as HTMLCanvasElement;
  let resizeCallback: (() => void) | undefined;
  const unsubscribe = vi.fn();
  const canvasSurface = {
    format: "bgra8unorm",
    size: [200, 100] as [number, number],
    dispose: vi.fn(),
    onResize: vi.fn((callback: () => void) => {
      resizeCallback = callback;
      callback();
      return unsubscribe;
    }),
    resize: vi.fn((size: readonly [number, number]) => {
      if (
        canvasSurface.size[0] === size[0] &&
        canvasSurface.size[1] === size[1]
      )
        return;
      canvasSurface.size = [...size];
      resizeCallback?.();
    }),
  };
  const gpu = { dispose: vi.fn() };
  const scenes: Array<{
    cascadeCount: number;
    directionBase: number;
    id: number;
    size: readonly [number, number];
  }> = [];
  mocks.init.mockResolvedValueOnce(gpu);
  mocks.surface.mockReturnValue(canvasSurface);
  mocks.createScene.mockImplementation(
    (_gpu: unknown, size: readonly [number, number], directionBase: number) => {
      const scene = {
        cascadeCount: size[1] / size[0] > 1.5 ? 5 : 6,
        directionBase,
        id: scenes.length + 1,
        size,
      };
      scenes.push(scene);
      return scene;
    }
  );

  const fireNext = (timestamp = 16) => {
    const entry = frames.entries().next().value as
      | [number, FrameRequestCallback]
      | undefined;
    if (!entry) throw new Error("No animation frame is pending.");
    frames.delete(entry[0]);
    entry[1](timestamp);
  };
  const change = (property: string, value: unknown) => {
    const controller = guiMocks.controllers.get(property);
    if (!controller) throw new Error(`Missing ${property} controller.`);
    controller.object[property] = value;
    controller.change?.();
  };

  return {
    canvas,
    canvasSurface,
    change,
    container,
    disconnect,
    fireNext,
    frames,
    gpu,
    resize() {
      observerCallback?.([], {} as ResizeObserver);
    },
    scenes,
    setSize(nextWidth: number, nextHeight: number) {
      width = nextWidth;
      height = nextHeight;
    },
    unsubscribe,
  };
}

afterEach(() => {
  guiMocks.controllers.clear();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

test("waits for GPU and shader preparation before mounting lil-gui", async () => {
  const env = setup();
  const initialization = deferred<typeof env.gpu>();
  const preparation = deferred<void>();
  mocks.init.mockReset().mockReturnValueOnce(initialization.promise);
  mocks.prepareScene.mockReturnValueOnce(preparation.promise);
  const renderer = createRenderer({ canvas: env.canvas });
  await vi.waitFor(() => expect(mocks.init).toHaveBeenCalledOnce());
  expect(guiMocks.construct).not.toHaveBeenCalled();

  initialization.resolve(env.gpu);
  await vi.waitFor(() => expect(mocks.prepareScene).toHaveBeenCalledOnce());
  expect(guiMocks.construct).not.toHaveBeenCalled();
  expect(env.frames.size).toBe(0);
  preparation.resolve();
  await renderer.ready;
  expect(guiMocks.construct).toHaveBeenCalledWith({
    title: "Agent Radiance Cascades",
    container: env.container,
    width: 210,
  });
  expect([...guiMocks.controllers.keys()]).toEqual([
    "animation",
    "quality",
    "view",
    "paused",
  ]);
  expect(mocks.surface).toHaveBeenCalledWith(env.gpu, env.canvas, {
    autoResize: false,
    dpr: 1,
  });
  renderer.dispose();
});

test("controls drive animation, throttling, pause, and visible views", async () => {
  const env = setup();
  const renderer = createRenderer({ canvas: env.canvas });
  await renderer.ready;
  env.fireNext(); // initial measured size
  env.fireNext(100);
  expect(mocks.renderLighting).toHaveBeenLastCalledWith(
    env.scenes[0],
    0,
    "final",
    "center-out"
  );

  env.change("animation", "edge-orbit");
  env.change("view", "jfa");
  env.fireNext(150);
  expect(mocks.renderLighting).toHaveBeenLastCalledWith(
    env.scenes[0],
    0.05,
    "jfa",
    "edge-orbit"
  );
  env.change("paused", true);
  env.fireNext(200);
  const calls = mocks.renderLighting.mock.calls.length;
  env.fireNext(300);
  expect(mocks.renderLighting).toHaveBeenCalledTimes(calls);
  expect(mocks.presentScene).toHaveBeenLastCalledWith(
    env.scenes[0],
    env.canvasSurface,
    "jfa"
  );
  renderer.dispose();
});

test("coalesces live resize, quality scaling, and five-cascade view bounds", async () => {
  const env = setup();
  const renderer = createRenderer({ canvas: env.canvas });
  await renderer.ready;
  env.fireNext();
  env.change("view", "cascade-5");
  env.setSize(160, 284);
  env.resize();
  env.resize();
  env.fireNext();
  env.fireNext();
  await vi.waitFor(() => expect(env.scenes).toHaveLength(2));
  expect(env.canvasSurface.resize).toHaveBeenLastCalledWith([160, 284]);
  expect(guiMocks.controllers.get("view")!.options).toHaveBeenCalledWith(
    expect.not.objectContaining({ "Cascade 5 atlas": "cascade-5" })
  );

  env.change("quality", "high");
  env.fireNext();
  env.fireNext();
  await vi.waitFor(() => expect(env.scenes).toHaveLength(3));
  expect(env.canvasSurface.resize).toHaveBeenLastCalledWith([200, 355]);
  expect(env.scenes[2]!.directionBase).toBe(3);
  expect(mocks.destroyScene).toHaveBeenCalledTimes(2);
  renderer.dispose();
});

test("owned teardown cleans browser state and delegates VGPU resources to the GPU", async () => {
  const env = setup();
  const renderer = createRenderer({ canvas: env.canvas });
  await renderer.ready;
  renderer.dispose();
  renderer.dispose();
  expect(env.frames.size).toBe(0);
  expect(env.disconnect).toHaveBeenCalledOnce();
  expect(env.unsubscribe).toHaveBeenCalledOnce();
  expect(guiMocks.destroy).toHaveBeenCalledOnce();
  expect(env.gpu.dispose).toHaveBeenCalledOnce();
  expect(env.canvasSurface.dispose).not.toHaveBeenCalled();
  expect(mocks.destroyScene).not.toHaveBeenCalled();
});

test("disposes a GPU that resolves after initialization is cancelled", async () => {
  const env = setup();
  const initialization = deferred<typeof env.gpu>();
  mocks.init.mockReset().mockReturnValueOnce(initialization.promise);
  const renderer = createRenderer({ canvas: env.canvas });
  await vi.waitFor(() => expect(mocks.init).toHaveBeenCalledOnce());
  renderer.dispose();
  initialization.resolve(env.gpu);
  await renderer.ready;
  expect(env.gpu.dispose).toHaveBeenCalledOnce();
  expect(mocks.surface).not.toHaveBeenCalled();
});

test("initial preparation failure tears down and preserves error identity", async () => {
  const env = setup();
  const failure = new Error("compile failed");
  mocks.prepareScene.mockRejectedValueOnce(failure);
  const renderer = createRenderer({ canvas: env.canvas });
  await expect(renderer.ready).rejects.toBe(failure);
  expect(guiMocks.construct).not.toHaveBeenCalled();
  expect(env.gpu.dispose).toHaveBeenCalledOnce();
  expect(env.canvasSurface.dispose).not.toHaveBeenCalled();
  expect(mocks.destroyScene).not.toHaveBeenCalled();
});

test("ignores a stale resize preparation failure", async () => {
  const env = setup();
  const stale = deferred<void>();
  mocks.prepareScene
    .mockResolvedValueOnce(undefined)
    .mockReturnValueOnce(stale.promise)
    .mockResolvedValueOnce(undefined);
  const renderer = createRenderer({ canvas: env.canvas });
  await renderer.ready;
  env.canvasSurface.resize([300, 200]);
  env.canvasSurface.resize([310, 200]);
  expect(env.scenes).toHaveLength(3);
  stale.reject(new Error("stale compile failed"));
  await Promise.resolve();
  expect(env.gpu.dispose).not.toHaveBeenCalled();
  renderer.dispose();
});

test("owned teardown remains best-effort when a browser cleanup fails", async () => {
  const env = setup();
  const renderer = createRenderer({ canvas: env.canvas });
  await renderer.ready;
  const failure = new Error("gui cleanup failed");
  guiMocks.destroy.mockImplementationOnce(() => {
    throw failure;
  });
  expect(() => renderer.dispose()).toThrow(failure);
  expect(env.disconnect).toHaveBeenCalledOnce();
  expect(env.unsubscribe).toHaveBeenCalledOnce();
  expect(env.gpu.dispose).toHaveBeenCalledOnce();
});

test("live rendering failure tears down and rethrows the same error", async () => {
  const env = setup();
  const renderer = createRenderer({ canvas: env.canvas });
  await renderer.ready;
  env.fireNext();
  env.fireNext();
  const failure = new Error("present failed");
  mocks.presentScene.mockImplementationOnce(() => {
    throw failure;
  });
  expect(() => env.fireNext()).toThrow(failure);
  expect(env.frames.size).toBe(0);
  expect(guiMocks.destroy).toHaveBeenCalledOnce();
  expect(env.gpu.dispose).toHaveBeenCalledOnce();
});

test("thumbnail cleanup waits for both shared-GPU barriers", async () => {
  const failure = new Error("compile failed");
  mocks.createScene.mockReturnValueOnce({});
  mocks.prepareScene.mockRejectedValueOnce(failure);
  const submitted = deferred<void>();
  const settled = deferred<void>();
  const gpu = {
    gpu: { queue: { onSubmittedWorkDone: vi.fn(() => submitted.promise) } },
    settled: vi.fn(() => settled.promise),
  };
  const rendering = renderThumbnail(
    gpu as never,
    { size: [160, 90], format: "rgba8unorm" } as never
  );
  await vi.waitFor(() => {
    expect(gpu.gpu.queue.onSubmittedWorkDone).toHaveBeenCalledOnce();
    expect(gpu.settled).toHaveBeenCalledOnce();
  });
  submitted.resolve();
  await Promise.resolve();
  expect(mocks.destroyScene).not.toHaveBeenCalled();
  settled.resolve();
  await expect(rendering).rejects.toBe(failure);
  expect(mocks.destroyScene).toHaveBeenCalledOnce();
});

test("thumbnail preserves its primary error across rejected barriers", async () => {
  const failure = new Error("compile failed");
  mocks.createScene.mockReturnValueOnce({});
  mocks.prepareScene.mockRejectedValueOnce(failure);
  const gpu = {
    gpu: {
      queue: {
        onSubmittedWorkDone: vi.fn(() => {
          throw new Error("drain failed");
        }),
      },
    },
    settled: vi.fn(() => Promise.reject(new Error("settle failed"))),
  };
  await expect(
    renderThumbnail(
      gpu as never,
      { size: [160, 90], format: "rgba8unorm" } as never
    )
  ).rejects.toBe(failure);
  expect(gpu.gpu.queue.onSubmittedWorkDone).toHaveBeenCalledOnce();
  expect(gpu.settled).toHaveBeenCalledOnce();
  expect(mocks.destroyScene).toHaveBeenCalledOnce();
});
