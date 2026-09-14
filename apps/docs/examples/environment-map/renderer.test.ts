import { beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createScene: vi.fn(),
  init: vi.fn(),
  render: vi.fn(),
  replaceHdr: vi.fn(),
}));

vi.mock("vgpu", () => ({
  init: mocks.init,
  clock: (gpu: FakeGpu) => gpu.clock,
  frameLoop: (gpu: FakeGpu, callback: (frame: unknown) => void) =>
    gpu.startLoop(callback),
  surface: (gpu: FakeGpu, canvas: HTMLCanvasElement, options: unknown) =>
    gpu.makeSurface(canvas, options),
}));

vi.mock("vgpu/scene", () => ({
  perspectiveCamera: vi.fn(() => ({ viewProjection: new Float32Array(16) })),
}));

vi.mock("./scene", () => ({
  aspectOf: (output: { size: readonly [number, number] }) =>
    output.size[0] / output.size[1],
  createScene: mocks.createScene,
  render: mocks.render,
  replaceHdr: mocks.replaceHdr,
  runCleanups(cleanups: readonly (() => void)[], primary?: { error: unknown }) {
    let firstError: unknown;
    let failed = false;
    for (const cleanup of cleanups) {
      try {
        cleanup();
      } catch (error) {
        if (!failed) firstError = error;
        failed = true;
      }
    }
    if (primary) throw primary.error;
    if (failed) throw firstError;
  },
}));

import { createRenderer, installOrbitInput } from "./renderer";

interface FakeSurface {
  format: GPUTextureFormat;
  size: [number, number];
  onResize(callback: () => void): () => void;
}

type MakeSurface = (canvas: HTMLCanvasElement, options: unknown) => FakeSurface;
type StartLoop = (callback: (frame: unknown) => void) => { stop(): void };

interface FakeGpu {
  readonly clock: { deltaTime: number; time: number };
  readonly dispose: ReturnType<typeof vi.fn>;
  readonly makeSurface: ReturnType<typeof vi.fn<MakeSurface>>;
  readonly startLoop: ReturnType<typeof vi.fn<StartLoop>>;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, reject, resolve };
}

function fakeCanvas() {
  const listeners = new Map<string, Set<(event: PointerEvent) => void>>();
  const captures = new Set<number>();
  let addCalls = 0;
  let failAddAt = 0;
  let addError: unknown;
  const style = { touchAction: "pan-y" };
  const canvas = {
    style,
    addEventListener: vi.fn(
      (
        type: string,
        listener: (event: PointerEvent) => void,
        options?: AddEventListenerOptions
      ) => {
        addCalls++;
        if (failAddAt === addCalls) throw addError;
        const entries = listeners.get(type) ?? new Set();
        entries.add(listener);
        listeners.set(type, entries);
        options?.signal?.addEventListener(
          "abort",
          () => entries.delete(listener),
          { once: true }
        );
      }
    ),
    removeEventListener: vi.fn(
      (type: string, listener: (event: PointerEvent) => void) => {
        listeners.get(type)?.delete(listener);
      }
    ),
    setPointerCapture: vi.fn((pointer: number) => captures.add(pointer)),
    hasPointerCapture: vi.fn((pointer: number) => captures.has(pointer)),
    releasePointerCapture: vi.fn((pointer: number) => captures.delete(pointer)),
  } as unknown as HTMLCanvasElement;

  return {
    canvas,
    captures,
    dispatch(type: string, event: Partial<PointerEvent> = {}) {
      const value = {
        clientX: 0,
        clientY: 0,
        isPrimary: true,
        pointerId: 1,
        ...event,
      } as PointerEvent;
      for (const listener of [...(listeners.get(type) ?? [])]) listener(value);
    },
    failAdd(call: number, error: unknown) {
      failAddAt = call;
      addError = error;
    },
    listenerCount() {
      return [...listeners.values()].reduce(
        (sum, entries) => sum + entries.size,
        0
      );
    },
  };
}

function setup() {
  const browser = fakeCanvas();
  let loopCallback: ((frame: unknown) => void) | undefined;
  let resizeCallback: (() => void) | undefined;
  const stop = vi.fn();
  const unsubscribe = vi.fn();
  const output = {
    format: "bgra8unorm" as GPUTextureFormat,
    size: [800, 450] as [number, number],
    onResize: vi.fn((callback: () => void) => {
      resizeCallback = callback;
      callback();
      return unsubscribe;
    }),
  };
  const gpu: FakeGpu = {
    clock: { deltaTime: 0.5, time: 2.1 },
    dispose: vi.fn(),
    makeSurface: vi.fn<MakeSurface>(() => output),
    startLoop: vi.fn<StartLoop>((callback) => {
      loopCallback = callback;
      return { stop };
    }),
  };
  const scene = { name: "scene", hdr: { size: [800, 450] } };
  mocks.init.mockResolvedValue(gpu);
  mocks.createScene.mockResolvedValue(scene);
  return {
    ...browser,
    gpu,
    output,
    scene,
    stop,
    unsubscribe,
    frame() {
      loopCallback?.({ name: "frame" });
    },
    resize() {
      resizeCallback?.();
    },
  };
}

beforeEach(() => {
  mocks.createScene.mockReset();
  mocks.init.mockReset();
  mocks.render.mockReset();
  mocks.replaceHdr.mockReset();
});

test("orbit input preserves drag, clamp, capture, cancel, leave, drift, and style behavior", () => {
  const browser = fakeCanvas();
  const input = installOrbitInput(browser.canvas);
  expect(browser.canvas.style.touchAction).toBe("none");

  input.advance(1);
  expect(input.yaw).toBeCloseTo(0.69);
  browser.dispatch("pointerdown", { isPrimary: false, pointerId: 2 });
  expect(browser.captures.size).toBe(0);

  browser.dispatch("pointerdown", { pointerId: 7, clientX: 10, clientY: 10 });
  expect(browser.captures.has(7)).toBe(true);
  input.advance(1);
  expect(input.yaw).toBeCloseTo(0.69);
  browser.dispatch("pointermove", { pointerId: 7, clientX: 110, clientY: 300 });
  expect(input.yaw).toBeCloseTo(0.09);
  expect(input.pitch).toBe(1.2);
  browser.dispatch("pointermove", {
    pointerId: 7,
    clientX: 110,
    clientY: -1000,
  });
  expect(input.pitch).toBe(-1.2);

  browser.dispatch("pointerleave", { pointerId: 7 });
  input.advance(1);
  expect(input.yaw).toBeCloseTo(0.09);
  browser.dispatch("pointercancel", { pointerId: 7 });
  expect(browser.captures.has(7)).toBe(false);
  input.advance(1);
  expect(input.yaw).toBeCloseTo(0.18);

  input.dispose();
  expect(browser.listenerCount()).toBe(0);
  expect(browser.canvas.style.touchAction).toBe("pan-y");
});

test("orbit input rolls back partial listener installation", () => {
  const browser = fakeCanvas();
  const primary = new Error("add listener");
  browser.failAdd(3, primary);
  expect(() => installOrbitInput(browser.canvas)).toThrow(primary);
  expect(browser.listenerCount()).toBe(0);
  expect(browser.canvas.style.touchAction).toBe("pan-y");
});

test("mounts one surface and cleans browser resources through the owning gpu", async () => {
  const state = setup();
  const renderer = createRenderer({ canvas: state.canvas });
  await renderer.ready;

  expect(state.gpu.makeSurface).toHaveBeenCalledWith(state.canvas, {
    dpr: [1, 2],
  });
  expect(state.listenerCount()).toBe(4);
  expect(mocks.replaceHdr).not.toHaveBeenCalled();
  state.frame();
  expect(mocks.render).toHaveBeenCalledOnce();

  state.output.size = [390, 844];
  state.resize();
  expect(mocks.replaceHdr).toHaveBeenCalledWith(
    state.gpu,
    state.scene,
    [390, 844]
  );

  renderer.dispose();
  expect(state.stop).toHaveBeenCalledOnce();
  expect(state.unsubscribe).toHaveBeenCalledOnce();
  expect(state.listenerCount()).toBe(0);
  expect(state.canvas.style.touchAction).toBe("pan-y");
  expect(state.gpu.dispose).toHaveBeenCalledOnce();
  state.output.size = [300, 300];
  state.resize();
  expect(mocks.replaceHdr).toHaveBeenCalledOnce();
});

test("direct dispose attempts every cleanup, reports the first, and stays idempotent", async () => {
  const state = setup();
  const first = new Error("stop");
  const second = new Error("unsubscribe");
  const third = new Error("release capture");
  state.stop.mockImplementation(() => {
    throw first;
  });
  state.unsubscribe.mockImplementation(() => {
    throw second;
  });
  state.canvas.releasePointerCapture = vi.fn(() => {
    throw third;
  });
  const renderer = createRenderer({ canvas: state.canvas });
  await renderer.ready;
  state.dispatch("pointerdown", { pointerId: 4 });

  expect(() => renderer.dispose()).toThrow(first);
  expect(state.unsubscribe).toHaveBeenCalledOnce();
  expect(state.canvas.releasePointerCapture).toHaveBeenCalledWith(4);
  expect(state.canvas.style.touchAction).toBe("pan-y");
  expect(state.gpu.dispose).toHaveBeenCalledOnce();
  expect(() => renderer.dispose()).not.toThrow();
});

test("disposes a gpu that resolves after an intentional early dispose", async () => {
  const state = setup();
  const pending = deferred<FakeGpu>();
  mocks.init.mockReturnValue(pending.promise);
  const renderer = createRenderer({ canvas: state.canvas });
  await vi.waitFor(() => expect(mocks.init).toHaveBeenCalledOnce());
  renderer.dispose();
  pending.resolve(state.gpu);
  await renderer.ready;

  expect(state.gpu.dispose).toHaveBeenCalledOnce();
  expect(state.gpu.makeSurface).not.toHaveBeenCalled();
});

test("quietly accepts a scene that resolves after intentional disposal", async () => {
  const state = setup();
  const pending = deferred<unknown>();
  mocks.createScene.mockReturnValue(pending.promise);
  const renderer = createRenderer({ canvas: state.canvas });
  await vi.waitFor(() => expect(mocks.createScene).toHaveBeenCalledOnce());
  renderer.dispose();
  pending.resolve(state.scene);

  await expect(renderer.ready).resolves.toBeUndefined();
  expect(state.gpu.dispose).toHaveBeenCalledOnce();
  expect(state.listenerCount()).toBe(0);
});

test("quietly accepts a scene rejection after intentional disposal", async () => {
  const state = setup();
  const pending = deferred<unknown>();
  mocks.createScene.mockReturnValue(pending.promise);
  const renderer = createRenderer({ canvas: state.canvas });
  await vi.waitFor(() => expect(mocks.createScene).toHaveBeenCalledOnce());
  renderer.dispose();
  const stale = new Error("disposed scene");
  pending.reject(stale);
  await expect(renderer.ready).resolves.toBeUndefined();
  expect(state.gpu.dispose).toHaveBeenCalledOnce();
  expect(state.listenerCount()).toBe(0);
});

test("initialization failures reject with exact identity after gpu cleanup", async () => {
  const state = setup();
  const primary = new Error("scene init");
  mocks.createScene.mockRejectedValue(primary);
  const renderer = createRenderer({ canvas: state.canvas });

  await expect(renderer.ready).rejects.toBe(primary);
  expect(state.gpu.dispose).toHaveBeenCalledOnce();
});

test("live frame and resize failures teardown and rethrow the primary error", async () => {
  const frameState = setup();
  const frameError = new Error("frame");
  mocks.render.mockImplementation(() => {
    throw frameError;
  });
  const frameRenderer = createRenderer({ canvas: frameState.canvas });
  await frameRenderer.ready;
  expect(() => frameState.frame()).toThrow(frameError);
  expect(frameState.gpu.dispose).toHaveBeenCalledOnce();
  expect(frameState.listenerCount()).toBe(0);

  const resizeState = setup();
  const resizeError = new Error("resize");
  mocks.replaceHdr.mockImplementation(() => {
    throw resizeError;
  });
  const resizeRenderer = createRenderer({ canvas: resizeState.canvas });
  await resizeRenderer.ready;
  resizeState.output.size = [390, 844];
  expect(() => resizeState.resize()).toThrow(resizeError);
  expect(resizeState.gpu.dispose).toHaveBeenCalledOnce();
  expect(resizeState.listenerCount()).toBe(0);
});

test("pointer capture failures teardown and preserve exact identity", async () => {
  const state = setup();
  const primary = new Error("capture");
  state.canvas.setPointerCapture = vi.fn(() => {
    throw primary;
  });
  const renderer = createRenderer({ canvas: state.canvas });
  await renderer.ready;

  expect(() => state.dispatch("pointerdown", { pointerId: 9 })).toThrow(
    primary
  );
  expect(state.gpu.dispose).toHaveBeenCalledOnce();
  expect(state.listenerCount()).toBe(0);
  expect(state.canvas.style.touchAction).toBe("pan-y");
});

test("partial pointer setup rolls back before initialization rejects", async () => {
  const state = setup();
  const primary = new Error("pointer listener");
  state.failAdd(4, primary);
  const renderer = createRenderer({ canvas: state.canvas });

  await expect(renderer.ready).rejects.toBe(primary);
  expect(state.listenerCount()).toBe(0);
  expect(state.canvas.style.touchAction).toBe("pan-y");
  expect(state.gpu.dispose).toHaveBeenCalledOnce();
});
