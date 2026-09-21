import { afterEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createEffects: vi.fn(),
  createTargets: vi.fn(),
  destroyTargets: vi.fn(),
  frame: vi.fn(),
  init: vi.fn(),
  prewarm: vi.fn(),
  renderChain: vi.fn(),
  setBakeUniforms: vi.fn(),
  setBindings: vi.fn(),
  setPostUniforms: vi.fn(),
  setShadeUniforms: vi.fn(),
  surface: vi.fn(),
}));

vi.mock("vgpu", () => ({
  frame: mocks.frame,
  init: mocks.init,
  surface: mocks.surface,
}));
vi.mock("./pipeline", () => ({
  createEffects: mocks.createEffects,
  createTargets: mocks.createTargets,
  destroyTargets: mocks.destroyTargets,
  prewarm: mocks.prewarm,
  renderChain: mocks.renderChain,
  setBakeUniforms: mocks.setBakeUniforms,
  setBindings: mocks.setBindings,
  setPostUniforms: mocks.setPostUniforms,
  setShadeUniforms: mocks.setShadeUniforms,
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

function setup(
  options: {
    dpr?: number;
    mobile?: boolean;
    search?: string;
  } = {}
) {
  let now = 0;
  let mobile = options.mobile ?? false;
  let nextFrame = 0;
  let resizeCallback: ResizeObserverCallback | undefined;
  let intersectionCallback: IntersectionObserverCallback | undefined;
  const frames = new Map<number, FrameRequestCallback>();
  const windowListeners = new Map<string, EventListener>();
  const documentListeners = new Map<string, EventListener>();
  const mediaListeners = new Set<EventListener>();

  const mediaQuery = {
    get matches() {
      return mobile;
    },
    addEventListener: vi.fn((_name: string, listener: EventListener) => {
      mediaListeners.add(listener);
    }),
    removeEventListener: vi.fn((_name: string, listener: EventListener) => {
      mediaListeners.delete(listener);
    }),
  };
  vi.stubGlobal("window", {
    addEventListener: vi.fn((name: string, listener: EventListener) => {
      windowListeners.set(name, listener);
    }),
    devicePixelRatio: options.dpr ?? 2,
    innerWidth: 200,
    location: { search: options.search ?? "" },
    matchMedia: vi.fn(() => mediaQuery),
    removeEventListener: vi.fn((name: string) => windowListeners.delete(name)),
  });
  const page = {
    hidden: false,
    addEventListener: vi.fn((name: string, listener: EventListener) => {
      documentListeners.set(name, listener);
    }),
    removeEventListener: vi.fn((name: string) =>
      documentListeners.delete(name)
    ),
  };
  vi.stubGlobal("document", page);
  vi.stubGlobal("performance", { now: () => now });
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

  const resizeObserve = vi.fn();
  const resizeDisconnect = vi.fn();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: ResizeObserverCallback) {
        resizeCallback = callback;
      }
      observe = resizeObserve;
      disconnect = resizeDisconnect;
    }
  );
  const intersectionObserve = vi.fn();
  const intersectionDisconnect = vi.fn();
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: IntersectionObserverCallback) {
        intersectionCallback = callback;
      }
      observe = intersectionObserve;
      disconnect = intersectionDisconnect;
    }
  );

  const canvasElement = {
    clientHeight: 100,
    clientWidth: 200,
  };
  const canvas = canvasElement as HTMLCanvasElement;
  const surface = {
    dispose: vi.fn(),
    format: "bgra8unorm",
    size: [200, 100],
  };
  const noiseVolume = { destroy: vi.fn() };
  const effects = { noiseVolume };
  const targets: Array<{ size: readonly [number, number] }> = [];
  const gpu = {
    dispose: vi.fn(),
    gpu: { queue: { onSubmittedWorkDone: vi.fn(async () => {}) } },
    settled: vi.fn(async () => {}),
  };
  const frame = { marker: "frame" };

  mocks.init.mockResolvedValue(gpu);
  mocks.surface.mockReturnValue(surface);
  mocks.createEffects.mockReturnValue(effects);
  mocks.createTargets.mockImplementation(
    (_vgpu: unknown, _gpu: unknown, size: readonly [number, number]) => {
      const value = { size: [...size] as [number, number] };
      targets.push(value);
      return value;
    }
  );
  mocks.prewarm.mockResolvedValue(undefined);
  mocks.frame.mockImplementation(
    (_gpu: unknown, render: (current: unknown) => void) => render(frame)
  );

  const fireNextFrame = (timestamp: number) => {
    const entry = frames.entries().next().value as
      | [number, FrameRequestCallback]
      | undefined;
    if (!entry) throw new Error("No animation frame is pending.");
    frames.delete(entry[0]);
    entry[1](timestamp);
  };

  return {
    canvas,
    documentListeners,
    effects,
    fireIntersection(isIntersecting: boolean) {
      intersectionCallback?.(
        [{ isIntersecting } as IntersectionObserverEntry],
        {} as IntersectionObserver
      );
    },
    fireMediaChange(matches: boolean) {
      mobile = matches;
      for (const listener of mediaListeners) {
        listener({ matches } as unknown as Event);
      }
    },
    fireNextFrame,
    fireResize() {
      resizeCallback?.([], {} as ResizeObserver);
    },
    frame,
    frames,
    gpu,
    intersectionDisconnect,
    intersectionObserve,
    mediaListeners,
    noiseVolume,
    page,
    resizeDisconnect,
    resizeObserve,
    setCanvasSize(width: number, height: number) {
      canvasElement.clientWidth = width;
      canvasElement.clientHeight = height;
    },
    setNow(value: number) {
      now = value;
    },
    surface,
    targets,
    windowListeners,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

test("coalesces resize, responds to input/layout, and delegates owned teardown", async () => {
  const env = setup();
  const renderer = createRenderer({ canvas: env.canvas });
  await renderer.ready;

  expect(mocks.surface).toHaveBeenCalledWith(env.gpu, env.canvas, { dpr: 1 });
  expect(mocks.createTargets.mock.calls[0]?.[2]).toEqual([200, 100]);
  expect(env.resizeObserve).toHaveBeenCalledWith(env.canvas);
  expect(env.intersectionObserve).toHaveBeenCalledWith(env.canvas);
  expect(env.frames.size).toBe(2);

  env.setCanvasSize(320, 180);
  env.fireResize();
  env.fireResize();
  expect(env.frames.size).toBe(2);
  env.fireNextFrame(1);
  expect(mocks.createTargets).toHaveBeenCalledTimes(2);
  expect(mocks.createTargets.mock.calls[1]?.[2]).toEqual([320, 180]);
  expect(mocks.destroyTargets).toHaveBeenCalledWith(env.targets[0]);

  env.windowListeners.get("pointermove")?.({
    clientX: 200,
    pointerType: "mouse",
  } as unknown as Event);
  env.fireNextFrame(16);
  expect(mocks.renderChain).toHaveBeenLastCalledWith(
    env.frame,
    env.effects,
    env.targets[1],
    env.surface,
    true
  );
  const desktopSettings = mocks.setBakeUniforms.mock.calls.at(-1)?.[2];
  expect(desktopSettings).toMatchObject({
    cameraRoll: -0.27,
    centerFade: 0,
    centerX: 0.8,
    centerY: 0.3,
    mouseYaw: 0.15,
  });

  env.setNow(100);
  env.fireNextFrame(33);
  const [, , , animationTime, sceneYaw] =
    mocks.setShadeUniforms.mock.calls.at(-1)!;
  expect(animationTime).toBeCloseTo(0.1);
  expect(sceneYaw).toBeGreaterThan(0);
  expect(mocks.renderChain).toHaveBeenLastCalledWith(
    env.frame,
    env.effects,
    env.targets[1],
    env.surface,
    false
  );

  env.fireMediaChange(true);
  env.setNow(117);
  env.fireNextFrame(50);
  const mobileSettings = mocks.setBakeUniforms.mock.calls.at(-1)?.[2];
  expect(mobileSettings).toMatchObject({
    cameraRoll: 0,
    centerFade: 1,
    centerX: 0,
    centerY: 0,
    mouseYaw: 0,
  });

  env.fireIntersection(false);
  expect(env.frames.size).toBe(0);
  env.fireIntersection(true);
  expect(env.frames.size).toBe(1);
  env.page.hidden = true;
  env.documentListeners.get("visibilitychange")?.({} as Event);
  expect(env.frames.size).toBe(0);
  env.page.hidden = false;
  env.documentListeners.get("visibilitychange")?.({} as Event);
  expect(env.frames.size).toBe(1);

  renderer.dispose();
  renderer.dispose();
  expect(env.frames.size).toBe(0);
  expect(env.resizeDisconnect).toHaveBeenCalledOnce();
  expect(env.intersectionDisconnect).toHaveBeenCalledOnce();
  expect(env.mediaListeners.size).toBe(0);
  expect(env.windowListeners.size).toBe(0);
  expect(env.documentListeners.size).toBe(0);
  expect(env.gpu.dispose).toHaveBeenCalledOnce();
  expect(env.surface.dispose).not.toHaveBeenCalled();
  expect(mocks.destroyTargets).toHaveBeenCalledTimes(1);
  expect(env.noiseVolume.destroy).not.toHaveBeenCalled();
});

test("disposes a GPU that resolves after initialization is cancelled", async () => {
  const env = setup();
  const pendingInit = deferred<typeof env.gpu>();
  mocks.init.mockReset().mockReturnValueOnce(pendingInit.promise);
  const renderer = createRenderer({ canvas: env.canvas });
  await vi.waitFor(() => expect(mocks.init).toHaveBeenCalledOnce());

  renderer.dispose();
  pendingInit.resolve(env.gpu);
  await renderer.ready;

  expect(env.gpu.dispose).toHaveBeenCalledOnce();
  expect(mocks.surface).not.toHaveBeenCalled();
  expect(mocks.createEffects).not.toHaveBeenCalled();
  expect(env.mediaListeners.size).toBe(0);
});

test("disposal during prewarm prevents late browser work", async () => {
  const env = setup();
  const pendingPrewarm = deferred<void>();
  mocks.prewarm.mockReset().mockReturnValueOnce(pendingPrewarm.promise);
  const renderer = createRenderer({ canvas: env.canvas });
  await vi.waitFor(() => expect(mocks.prewarm).toHaveBeenCalledOnce());

  renderer.dispose();
  pendingPrewarm.resolve();
  await renderer.ready;

  expect(env.gpu.dispose).toHaveBeenCalledOnce();
  expect(env.resizeObserve).not.toHaveBeenCalled();
  expect(env.intersectionObserve).not.toHaveBeenCalled();
  expect(env.frames.size).toBe(0);
  expect(env.windowListeners.size).toBe(0);
  expect(mocks.destroyTargets).not.toHaveBeenCalled();
});

test("resize binding failure destroys the candidate then tears down ownership", async () => {
  const env = setup();
  const renderer = createRenderer({ canvas: env.canvas });
  await renderer.ready;
  const failure = new Error("binding failed");
  mocks.setBindings.mockImplementationOnce(() => {
    throw failure;
  });

  expect(() => env.fireNextFrame(1)).toThrow(failure);
  expect(mocks.destroyTargets).toHaveBeenCalledOnce();
  expect(mocks.destroyTargets.mock.calls[0]?.[0]).toBe(env.targets[1]);
  expect(mocks.destroyTargets.mock.calls[0]?.[0]).not.toBe(env.targets[0]);
  expect(env.gpu.dispose).toHaveBeenCalledOnce();
  expect(env.frames.size).toBe(0);
});

test("frame encoding failure preserves the error and tears down browser ownership", async () => {
  const env = setup();
  const renderer = createRenderer({ canvas: env.canvas });
  await renderer.ready;
  env.fireNextFrame(1);
  mocks.destroyTargets.mockClear();
  const failure = new Error("frame encoding failed");
  mocks.renderChain.mockImplementationOnce(() => {
    throw failure;
  });

  let thrown: unknown;
  try {
    env.fireNextFrame(16);
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBe(failure);
  expect(env.frames.size).toBe(0);
  expect(env.resizeDisconnect).toHaveBeenCalledOnce();
  expect(env.intersectionDisconnect).toHaveBeenCalledOnce();
  expect(env.mediaListeners.size).toBe(0);
  expect(env.windowListeners.size).toBe(0);
  expect(env.documentListeners.size).toBe(0);
  expect(env.gpu.dispose).toHaveBeenCalledOnce();
  expect(env.surface.dispose).not.toHaveBeenCalled();
  expect(mocks.destroyTargets).not.toHaveBeenCalled();
  expect(env.noiseVolume.destroy).not.toHaveBeenCalled();
});

test("initialization failure preserves the error and delegates GPU teardown", async () => {
  const env = setup();
  const failure = new Error("compile failed");
  mocks.prewarm.mockRejectedValueOnce(failure);
  const renderer = createRenderer({ canvas: env.canvas });

  await expect(renderer.ready).rejects.toBe(failure);
  expect(env.gpu.dispose).toHaveBeenCalledOnce();
  expect(env.surface.dispose).not.toHaveBeenCalled();
  expect(mocks.destroyTargets).not.toHaveBeenCalled();
  expect(env.frames.size).toBe(0);
});

test("thumbnail renders requested frames then explicitly releases shared children", async () => {
  const env = setup();
  const output = { format: "rgba8unorm", size: [160, 90] };

  await renderThumbnail(env.gpu as never, output as never, {
    dt: 0.5,
    time: 1,
    warmupFrames: 2,
  });

  expect(mocks.setShadeUniforms.mock.calls.map((call) => call[3])).toEqual([
    1, 1.5,
  ]);
  expect(mocks.renderChain.mock.calls.map((call) => call[4])).toEqual([
    true,
    false,
  ]);
  expect(env.gpu.gpu.queue.onSubmittedWorkDone).toHaveBeenCalledTimes(2);
  expect(env.gpu.settled).toHaveBeenCalledTimes(2);
  expect(mocks.destroyTargets).toHaveBeenCalledWith(env.targets[0]);
  expect(env.noiseVolume.destroy).toHaveBeenCalledOnce();
  expect(env.gpu.dispose).not.toHaveBeenCalled();
});

test("thumbnail failure waits for shared work before child cleanup", async () => {
  const env = setup();
  const failure = new Error("compile failed");
  const drain = deferred<void>();
  const settle = deferred<void>();
  mocks.prewarm.mockRejectedValueOnce(failure);
  env.gpu.gpu.queue.onSubmittedWorkDone.mockReturnValueOnce(drain.promise);
  env.gpu.settled.mockReturnValueOnce(settle.promise);
  const output = { format: "rgba8unorm", size: [160, 90] };
  const rendering = renderThumbnail(env.gpu as never, output as never);

  await vi.waitFor(() => {
    expect(env.gpu.gpu.queue.onSubmittedWorkDone).toHaveBeenCalledOnce();
    expect(env.gpu.settled).toHaveBeenCalledOnce();
  });
  expect(mocks.destroyTargets).not.toHaveBeenCalled();
  expect(env.noiseVolume.destroy).not.toHaveBeenCalled();

  drain.resolve();
  settle.resolve();
  await expect(rendering).rejects.toBe(failure);
  expect(mocks.destroyTargets).toHaveBeenCalledWith(env.targets[0]);
  expect(env.noiseVolume.destroy).toHaveBeenCalledOnce();
});

test("thumbnail target creation failure releases effects without masking the error", async () => {
  const env = setup();
  const failure = new Error("target creation failed");
  mocks.createTargets.mockImplementationOnce(() => {
    throw failure;
  });
  env.gpu.gpu.queue.onSubmittedWorkDone.mockImplementationOnce(() => {
    throw new Error("queue drain failed");
  });
  env.gpu.settled.mockRejectedValueOnce(new Error("settling failed"));
  env.noiseVolume.destroy.mockImplementationOnce(() => {
    throw new Error("texture cleanup failed");
  });
  const output = { format: "rgba8unorm", size: [160, 90] };

  await expect(renderThumbnail(env.gpu as never, output as never)).rejects.toBe(
    failure
  );
  expect(env.gpu.gpu.queue.onSubmittedWorkDone).toHaveBeenCalledOnce();
  expect(env.gpu.settled).toHaveBeenCalledOnce();
  expect(mocks.destroyTargets).not.toHaveBeenCalled();
  expect(env.noiseVolume.destroy).toHaveBeenCalledOnce();
  expect(env.gpu.dispose).not.toHaveBeenCalled();
});
