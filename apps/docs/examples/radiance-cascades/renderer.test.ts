import { afterEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createScene: vi.fn(),
  destroyScene: vi.fn(),
  init: vi.fn(),
  inputDispose: vi.fn(),
  inputTake: vi.fn(),
  prepareScene: vi.fn(async () => {}),
  presentScene: vi.fn(),
  runChain: vi.fn(),
  surface: vi.fn(),
}));

const guiMocks = vi.hoisted(() => ({
  construct: vi.fn(),
  controllers: new Map<
    string,
    {
      change?: (value: unknown) => void;
      object: Record<string, unknown>;
      options: ReturnType<typeof vi.fn<(options: unknown) => void>>;
    }
  >(),
  destroy: vi.fn(),
}));

vi.mock("vgpu", () => ({
  init: mocks.init,
  surface: mocks.surface,
}));
vi.mock("./simulation", () => ({
  createScene: mocks.createScene,
  destroyScene: mocks.destroyScene,
  prepareScene: mocks.prepareScene,
  presentScene: mocks.presentScene,
  runChain: mocks.runChain,
}));
vi.mock("./pointer-input", () => ({
  installLightPaintInput: () => ({
    dispose: mocks.inputDispose,
    take: mocks.inputTake,
  }),
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
        change?: (value: unknown) => void;
        object: Record<string, unknown>;
        options: ReturnType<typeof vi.fn<(options: unknown) => void>>;
      };
      const controller = {
        name: vi.fn(() => controller),
        onChange: vi.fn((change: (value: unknown) => void) => {
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
  const windowListeners = new Map<string, EventListener>();
  let nextFrame = 0;
  vi.stubGlobal("document", { hidden: false });
  vi.stubGlobal("window", {
    devicePixelRatio: 2,
    addEventListener: vi.fn((name: string, listener: EventListener) => {
      windowListeners.set(name, listener);
    }),
    removeEventListener: vi.fn((name: string) => windowListeners.delete(name)),
  });
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
    style: { touchAction: "pan-y" },
    getBoundingClientRect: () => ({ width, height }),
  } as unknown as HTMLCanvasElement;
  let resizeCallback: (() => void) | undefined;
  const unsubscribe = vi.fn();
  const surface = {
    format: "bgra8unorm",
    size: [400, 200] as [number, number],
    dispose: vi.fn(),
    onResize: vi.fn((callback: () => void) => {
      resizeCallback = callback;
      callback();
      return unsubscribe;
    }),
    resize: vi.fn((size: [number, number]) => {
      if (surface.size[0] === size[0] && surface.size[1] === size[1]) return;
      surface.size = [...size];
      resizeCallback?.();
    }),
  };
  const gpu = { dispose: vi.fn() };
  const scenes: Array<{ cascadeCount: number; id: number }> = [];
  mocks.init.mockResolvedValueOnce(gpu);
  mocks.surface.mockReturnValue(surface);
  mocks.createScene.mockImplementation(() => {
    const value = {
      cascadeCount: scenes.length ? 5 : 6,
      id: scenes.length + 1,
    };
    scenes.push(value);
    return value;
  });

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
    controller.change?.(value);
  };

  return {
    canvas,
    change,
    container,
    disconnect,
    fireResize() {
      observerCallback?.([], {} as ResizeObserver);
    },
    fireNext,
    frames,
    gpu,
    scenes,
    setCanvasSize(nextWidth: number, nextHeight: number) {
      width = nextWidth;
      height = nextHeight;
    },
    surface,
    unsubscribe,
    windowListeners,
  };
}

afterEach(() => {
  guiMocks.controllers.clear();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

test("mounts container-scoped lil-gui after loading and drives every control", async () => {
  const env = setup();
  const preparation = deferred<void>();
  mocks.prepareScene.mockReturnValueOnce(preparation.promise);
  const renderer = createRenderer({ canvas: env.canvas });
  await vi.waitFor(() => expect(mocks.prepareScene).toHaveBeenCalledOnce());
  expect(guiMocks.construct).not.toHaveBeenCalled();
  expect(env.frames.size).toBe(0);

  preparation.resolve();
  await renderer.ready;
  expect(guiMocks.construct).toHaveBeenCalledWith({
    title: "Radiance Cascades",
    container: env.container,
    width: 190,
  });
  expect(guiMocks.controllers.has("view")).toBe(true);
  expect(guiMocks.controllers.has("clear")).toBe(true);

  env.fireNext();
  env.change("view", "cascade-5");
  env.fireNext();
  expect(mocks.runChain).toHaveBeenLastCalledWith(env.scenes[0], {
    segment: undefined,
    keepPrevious: true,
    view: "cascade-5",
  });

  const clear = guiMocks.controllers.get("clear")!.object.clear as () => void;
  clear();
  env.fireNext();
  expect(mocks.runChain).toHaveBeenLastCalledWith(env.scenes[0], {
    segment: undefined,
    keepPrevious: false,
    view: "cascade-5",
  });

  renderer.dispose();
});

test("coalesces resize, updates five-cascade controls, and delegates owned teardown", async () => {
  const env = setup();
  const renderer = createRenderer({ canvas: env.canvas });
  await renderer.ready;
  expect(mocks.surface).toHaveBeenCalledWith(env.gpu, env.canvas, {
    autoResize: false,
    dpr: [1, 2],
  });
  env.change("view", "cascade-5");

  env.fireNext();
  env.setCanvasSize(160, 284);
  env.fireResize();
  env.fireNext();
  env.fireNext();
  expect(env.surface.resize).toHaveBeenCalledWith([320, 568]);
  await vi.waitFor(() => expect(mocks.createScene).toHaveBeenCalledTimes(2));
  expect(mocks.destroyScene).toHaveBeenCalledWith(env.scenes[0]);
  expect(guiMocks.controllers.get("view")!.options).toHaveBeenCalledWith(
    expect.not.objectContaining({ "Cascade 5 atlas": "cascade-5" })
  );
  env.fireNext();
  expect(mocks.runChain).toHaveBeenLastCalledWith(env.scenes[1], {
    segment: undefined,
    keepPrevious: false,
    view: "cascade-4",
  });

  renderer.dispose();
  renderer.dispose();
  expect(env.frames.size).toBe(0);
  expect(env.disconnect).toHaveBeenCalledOnce();
  expect(env.unsubscribe).toHaveBeenCalledOnce();
  expect(mocks.inputDispose).toHaveBeenCalledOnce();
  expect(guiMocks.destroy).toHaveBeenCalledOnce();
  expect(env.windowListeners.size).toBe(0);
  expect(env.gpu.dispose).toHaveBeenCalledOnce();
  expect(env.surface.dispose).not.toHaveBeenCalled();
  expect(mocks.destroyScene).toHaveBeenCalledTimes(1);
});

test("coalesced pointer input dirties the chain", async () => {
  const env = setup();
  const segment = { from: [0.1, 0.2], to: [0.7, 0.8], stroke: 1 };
  mocks.inputTake.mockReturnValueOnce(segment);
  const renderer = createRenderer({ canvas: env.canvas });
  await renderer.ready;

  env.fireNext();
  env.fireNext();
  expect(mocks.runChain).toHaveBeenLastCalledWith(env.scenes[0], {
    segment,
    keepPrevious: true,
    view: "final",
  });
  renderer.dispose();
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

test("preparation failure tears down the owned GPU and preserves error identity", async () => {
  const env = setup();
  const failure = new Error("compile failed");
  mocks.prepareScene.mockRejectedValueOnce(failure);
  const renderer = createRenderer({ canvas: env.canvas });

  await expect(renderer.ready).rejects.toBe(failure);
  expect(guiMocks.construct).not.toHaveBeenCalled();
  expect(env.gpu.dispose).toHaveBeenCalledOnce();
  expect(env.surface.dispose).not.toHaveBeenCalled();
  expect(mocks.destroyScene).not.toHaveBeenCalled();
});

test("live rendering failure tears down browser ownership and rethrows", async () => {
  const env = setup();
  const renderer = createRenderer({ canvas: env.canvas });
  await renderer.ready;
  env.fireNext();
  const failure = new Error("present failed");
  mocks.presentScene.mockImplementationOnce(() => {
    throw failure;
  });

  expect(() => env.fireNext()).toThrow(failure);
  expect(env.frames.size).toBe(0);
  expect(mocks.inputDispose).toHaveBeenCalledOnce();
  expect(guiMocks.destroy).toHaveBeenCalledOnce();
  expect(env.gpu.dispose).toHaveBeenCalledOnce();
});

test("a stale resize compilation failure does not tear down its replacement", async () => {
  const env = setup();
  const stale = deferred<void>();
  mocks.prepareScene
    .mockResolvedValueOnce(undefined)
    .mockReturnValueOnce(stale.promise)
    .mockResolvedValueOnce(undefined);
  const renderer = createRenderer({ canvas: env.canvas });
  await renderer.ready;

  env.fireNext();
  env.surface.resize([300, 200]);
  env.surface.resize([310, 200]);
  expect(mocks.createScene).toHaveBeenCalledTimes(3);
  const failure = new Error("stale compile failed");
  stale.reject(failure);
  await Promise.resolve();

  expect(env.gpu.dispose).not.toHaveBeenCalled();
  renderer.dispose();
});

test("thumbnail cleanup waits for both shared-GPU barriers", async () => {
  const failure = new Error("compile failed");
  mocks.createScene.mockReturnValueOnce({ cascadeCount: 6 });
  mocks.prepareScene.mockRejectedValueOnce(failure);
  const submitted = deferred<void>();
  const settled = deferred<void>();
  const gpu = {
    gpu: { queue: { onSubmittedWorkDone: vi.fn(() => submitted.promise) } },
    settled: vi.fn(() => settled.promise),
  };
  const rendering = renderThumbnail(
    gpu as never,
    {
      size: [160, 90],
      format: "rgba8unorm",
    } as never
  );

  await vi.waitFor(() => {
    expect(gpu.gpu.queue.onSubmittedWorkDone).toHaveBeenCalledOnce();
    expect(gpu.settled).toHaveBeenCalledOnce();
  });
  expect(mocks.destroyScene).not.toHaveBeenCalled();
  submitted.resolve();
  await Promise.resolve();
  expect(mocks.destroyScene).not.toHaveBeenCalled();
  settled.resolve();
  await expect(rendering).rejects.toBe(failure);
  expect(mocks.destroyScene).toHaveBeenCalledOnce();
});

test("thumbnail cleanup preserves its primary error across rejected barriers", async () => {
  const failure = new Error("compile failed");
  mocks.createScene.mockReturnValueOnce({ cascadeCount: 6 });
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
      {
        size: [160, 90],
        format: "rgba8unorm",
      } as never
    )
  ).rejects.toBe(failure);
  expect(gpu.gpu.queue.onSubmittedWorkDone).toHaveBeenCalledOnce();
  expect(gpu.settled).toHaveBeenCalledOnce();
  expect(mocks.destroyScene).toHaveBeenCalledOnce();
});
