import { afterEach, expect, test, vi } from "vitest";

type InstallDragOrbit = typeof import("./pointer-input").installDragOrbit;

const mocks = vi.hoisted(() => ({
  actualInstallInput: undefined as InstallDragOrbit | undefined,
  compileScene: vi.fn(),
  createScene: vi.fn(),
  frame: vi.fn(),
  init: vi.fn(),
  installInput: vi.fn(),
  renderScene: vi.fn(),
  replaceTargets: vi.fn(),
  surface: vi.fn(),
}));

vi.mock("vgpu", () => ({
  frame: (gpu: unknown, render: (currentFrame: unknown) => void) =>
    mocks.frame(gpu, render),
  init: mocks.init,
  surface: mocks.surface,
}));
vi.mock("./pipeline", () => ({
  POSTER: { yaw: 0.58, pitch: 0.24 },
  compileScene: mocks.compileScene,
  createScene: mocks.createScene,
  renderScene: mocks.renderScene,
  replaceTargets: mocks.replaceTargets,
}));
vi.mock("./pointer-input", async () => {
  const original = await vi.importActual<typeof import("./pointer-input")>(
    "./pointer-input"
  );
  mocks.actualInstallInput = original.installDragOrbit;
  return { ...original, installDragOrbit: mocks.installInput };
});

import { createRenderer } from "./renderer";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, reject, resolve };
}

function setup() {
  let nextFrame = 0;
  let observerCallback: ResizeObserverCallback | undefined;
  let inputFailure: ((error: unknown) => never) | undefined;
  const frames = new Map<number, FrameRequestCallback>();
  const windowListeners = new Map<string, EventListener>();
  const browserWindow = {
    devicePixelRatio: 2,
    addEventListener: vi.fn((type: string, listener: EventListener) => {
      windowListeners.set(type, listener);
    }),
    removeEventListener: vi.fn((type: string, listener: EventListener) => {
      if (windowListeners.get(type) === listener) windowListeners.delete(type);
    }),
  };
  vi.stubGlobal("window", browserWindow);
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
  const observe = vi.fn();
  const disconnect = vi.fn();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: ResizeObserverCallback) {
        observerCallback = callback;
      }
      observe = observe;
      disconnect = disconnect;
    }
  );

  const pointerListeners = new Map<string, Set<EventListener>>();
  const captured = new Set<number>();
  const releaseCalls: number[] = [];
  const releaseErrorsBeforeClear: unknown[] = [];
  const canvasState = {
    style: { touchAction: "pan-y" },
    addEventListener(type: string, listener: EventListener) {
      const listeners = pointerListeners.get(type) ?? new Set();
      listeners.add(listener);
      pointerListeners.set(type, listeners);
    },
    removeEventListener(type: string, listener: EventListener) {
      pointerListeners.get(type)?.delete(listener);
    },
    setPointerCapture(id: number) {
      captured.add(id);
    },
    hasPointerCapture(id: number) {
      return captured.has(id);
    },
    releasePointerCapture(id: number) {
      releaseCalls.push(id);
      if (releaseErrorsBeforeClear.length) {
        throw releaseErrorsBeforeClear.shift();
      }
      captured.delete(id);
    },
  };
  const canvas = canvasState as unknown as HTMLCanvasElement;
  const output = {
    dispose: vi.fn(),
    format: "bgra8unorm",
    size: [320, 160] as [number, number],
  };
  const gpu = { dispose: vi.fn() };
  const scene = {
    targets: { scene: { size: [320, 160] as [number, number] } },
  };
  const inputDispose = vi.fn();
  mocks.init.mockResolvedValue(gpu);
  mocks.surface.mockReturnValue(output);
  mocks.createScene.mockReturnValue(scene);
  mocks.compileScene.mockResolvedValue(undefined);
  mocks.installInput.mockImplementation(
    (_canvas, _orbit, _requestRender, onError: (error: unknown) => never) => {
      inputFailure = onError;
      return inputDispose;
    }
  );
  mocks.frame.mockImplementation((_gpu, render) => render({ frame: true }));

  const fireNext = (time = 0) => {
    const entry = frames.entries().next().value as
      | [number, FrameRequestCallback]
      | undefined;
    if (!entry) throw new Error("No animation frame is pending.");
    frames.delete(entry[0]);
    entry[1](time);
  };
  return {
    browserWindow,
    canvas,
    canvasState,
    captured,
    disconnect,
    fireInputFailure(error: unknown) {
      if (!inputFailure) throw new Error("Input is not installed.");
      inputFailure(error);
    },
    fireNext,
    fireObserver() {
      observerCallback?.([], {} as ResizeObserver);
    },
    firePointer(type: string, event: Partial<PointerEvent>) {
      for (const listener of [...(pointerListeners.get(type) ?? [])]) {
        listener(event as PointerEvent);
      }
    },
    frames,
    gpu,
    inputDispose,
    observe,
    output,
    pointerListeners,
    releaseCalls,
    releaseErrorsBeforeClear,
    scene,
    setOutputSize(width: number, height: number) {
      output.size = [width, height];
    },
    windowListeners,
  };
}

afterEach(async () => {
  await vi.dynamicImportSettled();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

test("coalesces resize and invalidation, then delegates all VGPU teardown to the GPU", async () => {
  const env = setup();
  const renderer = createRenderer({ canvas: env.canvas });
  await renderer.ready;

  expect(mocks.surface).toHaveBeenCalledWith(env.gpu, env.canvas, {
    dpr: [1, 1.6],
  });
  expect(mocks.createScene).toHaveBeenCalledWith(env.gpu, env.output.size);
  expect(mocks.compileScene).toHaveBeenCalledWith(env.scene, env.output);
  expect(env.observe).toHaveBeenCalledWith(env.canvas);
  expect(env.frames.size).toBe(1);
  env.fireNext();
  expect(mocks.renderScene).toHaveBeenCalledWith(
    { frame: true },
    env.scene,
    env.output,
    { yaw: 0.58, pitch: 0.24 }
  );

  env.setOutputSize(480, 320);
  env.fireObserver();
  env.setOutputSize(400, 240);
  env.fireObserver();
  renderer.invalidate();
  renderer.invalidate();
  expect(env.frames.size).toBe(1);
  env.fireNext();
  expect(mocks.replaceTargets).toHaveBeenCalledWith(
    env.gpu,
    env.scene,
    [400, 240]
  );
  expect(mocks.renderScene).toHaveBeenCalledTimes(2);

  renderer.invalidate();
  expect(env.frames.size).toBe(1);
  renderer.dispose();
  renderer.dispose();
  expect(env.frames.size).toBe(0);
  expect(env.disconnect).toHaveBeenCalledOnce();
  expect(env.windowListeners.size).toBe(0);
  expect(env.inputDispose).toHaveBeenCalledOnce();
  expect(env.gpu.dispose).toHaveBeenCalledOnce();
  expect(env.output.dispose).not.toHaveBeenCalled();
});

test("only a device-pixel-ratio change triggers the window resize path", async () => {
  const env = setup();
  const renderer = createRenderer({ canvas: env.canvas });
  await renderer.ready;
  env.fireNext();
  const resizeListener = env.windowListeners.get("resize")!;

  resizeListener({} as Event);
  expect(env.frames.size).toBe(0);
  env.browserWindow.devicePixelRatio = 1.25;
  env.setOutputSize(250, 125);
  resizeListener({} as Event);
  expect(env.frames.size).toBe(1);
  env.fireNext();
  expect(mocks.replaceTargets).toHaveBeenLastCalledWith(
    env.gpu,
    env.scene,
    [250, 125]
  );
  renderer.dispose();
});

test("disposal before init resolves is idempotent and disposes only the late GPU", async () => {
  const env = setup();
  const initialization = deferred<typeof env.gpu>();
  mocks.init.mockReturnValue(initialization.promise);
  const renderer = createRenderer({ canvas: env.canvas });
  await vi.waitFor(() => expect(mocks.init).toHaveBeenCalledOnce());

  renderer.dispose();
  renderer.dispose();
  initialization.resolve(env.gpu);
  await renderer.ready;
  expect(env.gpu.dispose).toHaveBeenCalledOnce();
  expect(mocks.surface).not.toHaveBeenCalled();
});

test("disposal during compilation is immediate and a stale rejection stays quiet", async () => {
  const env = setup();
  const compilation = deferred<void>();
  mocks.compileScene.mockReturnValue(compilation.promise);
  const renderer = createRenderer({ canvas: env.canvas });
  await vi.waitFor(() => expect(mocks.compileScene).toHaveBeenCalledOnce());

  renderer.dispose();
  expect(env.gpu.dispose).toHaveBeenCalledOnce();
  const stale = new Error("stale compile failed");
  compilation.reject(stale);
  await expect(renderer.ready).resolves.toBeUndefined();
  expect(mocks.installInput).not.toHaveBeenCalled();
});

test("live initialization failure preserves identity even when GPU cleanup fails", async () => {
  const env = setup();
  const primary = new Error("compile failed");
  mocks.compileScene.mockRejectedValue(primary);
  env.gpu.dispose.mockImplementation(() => {
    throw new Error("cleanup failed");
  });

  await expect(createRenderer({ canvas: env.canvas }).ready).rejects.toBe(
    primary
  );
  expect(env.gpu.dispose).toHaveBeenCalledOnce();
  expect(mocks.installInput).not.toHaveBeenCalled();
});

test("live resize failure tears down every browser owner and keeps the primary error", async () => {
  const env = setup();
  const renderer = createRenderer({ canvas: env.canvas });
  await renderer.ready;
  env.setOutputSize(400, 240);
  env.fireObserver();
  const primary = new Error("resize failed");
  mocks.replaceTargets.mockImplementation(() => {
    throw primary;
  });
  env.inputDispose.mockImplementation(() => {
    throw new Error("input cleanup failed");
  });
  env.gpu.dispose.mockImplementation(() => {
    throw new Error("GPU cleanup failed");
  });

  expect(() => env.fireNext()).toThrow(primary);
  expect(env.disconnect).toHaveBeenCalledOnce();
  expect(env.inputDispose).toHaveBeenCalledOnce();
  expect(env.gpu.dispose).toHaveBeenCalledOnce();
  expect(env.windowListeners.size).toBe(0);
  expect(env.frames.size).toBe(0);
  renderer.dispose();
});

test("live frame and pointer failures tear down and preserve exact identity", async () => {
  const frameEnv = setup();
  const frameRenderer = createRenderer({ canvas: frameEnv.canvas });
  await frameRenderer.ready;
  frameEnv.fireNext();
  const frameFailure = new Error("frame failed");
  mocks.renderScene.mockImplementation(() => {
    throw frameFailure;
  });
  frameRenderer.invalidate();
  expect(() => frameEnv.fireNext()).toThrow(frameFailure);
  expect(frameEnv.gpu.dispose).toHaveBeenCalledOnce();

  vi.resetAllMocks();
  vi.unstubAllGlobals();
  const pointerEnv = setup();
  const pointerRenderer = createRenderer({ canvas: pointerEnv.canvas });
  await pointerRenderer.ready;
  const pointerFailure = new Error("pointer capture failed");
  expect(() => pointerEnv.fireInputFailure(pointerFailure)).toThrow(
    pointerFailure
  );
  expect(pointerEnv.gpu.dispose).toHaveBeenCalledOnce();
  expect(pointerEnv.inputDispose).toHaveBeenCalledOnce();
});

test("pointer release retry failure preserves the callback while completing teardown", async () => {
  const env = setup();
  mocks.installInput.mockImplementation(mocks.actualInstallInput!);
  const renderer = createRenderer({ canvas: env.canvas });
  await renderer.ready;

  const primary = new Error("pointer release failed");
  const retry = new Error("pointer release retry failed");
  env.releaseErrorsBeforeClear.push(primary, retry);
  env.firePointer("pointerdown", {
    pointerId: 8,
    clientX: 0,
    clientY: 0,
    isPrimary: true,
  });

  expect(() =>
    env.firePointer("pointercancel", {
      pointerId: 8,
      clientX: 0,
      clientY: 0,
      isPrimary: true,
    })
  ).toThrow(primary);
  expect(env.releaseCalls).toEqual([8, 8]);
  expect(env.captured).toEqual(new Set([8]));
  expect(env.canvasState.style.touchAction).toBe("pan-y");
  expect(
    [...env.pointerListeners.values()].every(
      (listeners) => listeners.size === 0
    )
  ).toBe(true);
  expect(env.disconnect).toHaveBeenCalledOnce();
  expect(env.windowListeners.size).toBe(0);
  expect(env.gpu.dispose).toHaveBeenCalledOnce();
  renderer.dispose();
});
