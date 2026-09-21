import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface GuiController {
  object: Record<string, () => void>;
  property: string;
  label: string;
  invoke(): void;
}

const mocks = vi.hoisted(() => ({
  assertGpuTensor: vi.fn(),
  charts: [] as ReturnType<typeof vi.fn>[],
  createChart: vi.fn(),
  createLogits: vi.fn(),
  createShared: vi.fn(),
  guis: [] as Array<{
    options: Record<string, unknown>;
    domElement: { style: Record<string, string> };
    controllers: GuiController[];
    destroy: ReturnType<typeof vi.fn>;
  }>,
  preprocess: vi.fn(),
  surface: vi.fn(),
  withWrappedTensor: vi.fn(),
  guiDestroyError: undefined as unknown,
  guiNameError: undefined as unknown,
  guiNameHook: undefined as (() => void) | undefined,
}));

vi.mock("lil-gui", () => ({
  default: class {
    readonly domElement = { style: {} as Record<string, string> };
    readonly controllers: GuiController[] = [];
    readonly destroy = vi.fn(() => {
      if (mocks.guiDestroyError) throw mocks.guiDestroyError;
    });
    constructor(readonly options: Record<string, unknown>) {
      mocks.guis.push(this);
    }
    add(object: Record<string, () => void>, property: string) {
      const controller: GuiController = {
        object,
        property,
        label: property,
        invoke: () => object[property]!(),
      };
      this.controllers.push(controller);
      return {
        name(label: string) {
          controller.label = label;
          mocks.guiNameHook?.();
          if (mocks.guiNameError) throw mocks.guiNameError;
          return this;
        },
      };
    }
  },
}));
vi.mock("vgpu", () => ({ surface: mocks.surface }));
vi.mock("./renderer", () => ({
  createChart: mocks.createChart,
  createLogitsBuffer: mocks.createLogits,
}));
vi.mock("./preprocess", () => ({
  INPUT_SIZE: 28,
  foregroundFromRgba: vi.fn(() => new Float32Array(280 * 280)),
  preprocessDigit: mocks.preprocess,
}));
vi.mock("./ort-webgpu", () => {
  class FirstError {
    error: unknown;
    failed: boolean;
    constructor(error?: unknown, failed = false) {
      this.error = error;
      this.failed = failed;
    }
    capture(error: unknown) {
      if (!this.failed) this.error = error;
      this.failed = true;
    }
    run(action: () => void) {
      try {
        action();
      } catch (error) {
        this.capture(error);
      }
    }
    async wait(promise: Promise<unknown> | undefined) {
      try {
        await promise;
      } catch (error) {
        this.capture(error);
      }
    }
    throwIfAny() {
      if (this.failed) throw this.error;
    }
  }
  return {
    FirstError,
    OrtEnvironmentError: class extends Error {},
    OrtInitCancelled: class extends Error {},
    assertGpuTensor: mocks.assertGpuTensor,
    createSharedDeviceSession: mocks.createShared,
    withWrappedTensor: mocks.withWrappedTensor,
  };
});

import { createRenderer, installDrawing } from "./ort-runtime";

class FakeElement {
  hidden = false;
  textContent: string | null = null;
  className = "";
}

class FakeCanvas extends FakeElement {
  readonly listeners = new Map<string, Set<(event: PointerEvent) => void>>();
  readonly captured = new Set<number>();
  readonly style = { touchAction: "pan-x" };
  removeError: { type: string; error: unknown } | undefined;
  width = 280;
  height = 280;
  constructor(readonly context?: ReturnType<typeof fakeContext>) {
    super();
  }
  getContext() {
    return this.context ?? null;
  }
  getBoundingClientRect() {
    return { left: 10, top: 20, width: 400, height: 200 };
  }
  addEventListener(type: string, listener: (event: PointerEvent) => void) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }
  removeEventListener(type: string, listener: (event: PointerEvent) => void) {
    this.listeners.get(type)?.delete(listener);
    if (this.removeError?.type === type) {
      const { error } = this.removeError;
      this.removeError = undefined;
      throw error;
    }
  }
  dispatch(type: string, event: Partial<PointerEvent> = {}) {
    const value = {
      pointerId: 1,
      clientX: 50,
      clientY: 60,
      ...event,
    } as PointerEvent;
    this.listeners.get(type)?.forEach((listener) => listener(value));
  }
  setPointerCapture(id: number) {
    this.captured.add(id);
  }
  hasPointerCapture(id: number) {
    return this.captured.has(id);
  }
  releasePointerCapture(id: number) {
    this.captured.delete(id);
  }
}

function fakeContext() {
  return {
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 0,
    lineCap: "butt",
    lineJoin: "miter",
    fillRect: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    getImageData: vi.fn(() => ({ data: new Uint8ClampedArray(280 * 280 * 4) })),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, reject, resolve };
}

function captureMicrotasks() {
  const callbacks: (() => void)[] = [];
  vi.stubGlobal(
    "queueMicrotask",
    vi.fn((callback: () => void) => callbacks.push(callback))
  );
  return callbacks;
}

function fakeShared(run?: () => Promise<Record<string, unknown>>) {
  const inputs: Array<{ dispose: ReturnType<typeof vi.fn> }> = [];
  const outputs: Array<{ dispose: ReturnType<typeof vi.fn> }> = [];
  const Tensor = vi.fn(function () {
    const input = { dispose: vi.fn() };
    inputs.push(input);
    return input;
  });
  const session = {
    inputNames: ["input"],
    outputNames: ["output"],
    run: vi.fn(
      run ??
        (async () => {
          const output = { dispose: vi.fn() };
          outputs.push(output);
          return { output };
        })
    ),
  };
  return {
    value: {
      ort: { Tensor },
      session,
      gpu: { marker: "gpu" },
      release: vi.fn(async () => undefined),
    },
    inputs,
    outputs,
    session,
  };
}

function setup(
  options: {
    shared?: ReturnType<typeof fakeShared>;
    sharedPromise?: Promise<unknown>;
  } = {}
) {
  const context = fakeContext();
  const draw = new FakeCanvas(context);
  const chartCanvas = new FakeCanvas();
  const elements = new Map<string, FakeElement>([
    ["draw", draw],
    ["chart", chartCanvas],
    ...[
      "loading",
      "loading-detail",
      "failure",
      "failure-title",
      "failure-detail",
      "dot",
      "status",
    ].map((name) => [name, new FakeElement()] as const),
  ]);
  const root = {
    querySelector(selector: string) {
      return (
        elements.get(selector.match(/data-mnist="([^"]+)/)?.[1] ?? "") ?? null
      );
    },
  } as unknown as HTMLElement;
  const shared = options.shared ?? fakeShared();
  mocks.createShared.mockImplementation(
    () => options.sharedPromise ?? Promise.resolve(shared.value)
  );
  const output = { resize: vi.fn() };
  const idle = { dispose: vi.fn() };
  const chart = vi.fn();
  mocks.surface.mockReturnValue(output);
  mocks.createLogits.mockReturnValue(idle);
  mocks.createChart.mockReturnValue(chart);
  mocks.assertGpuTensor.mockReturnValue({ size: 40 });
  mocks.withWrappedTensor.mockImplementation(async (_gpu, _raw, consume) =>
    consume({})
  );
  mocks.preprocess.mockReturnValue(new Float32Array(28 * 28).fill(1));

  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn((callback: FrameRequestCallback) => {
      frames.set(++frameId, callback);
      return frameId;
    })
  );
  vi.stubGlobal(
    "cancelAnimationFrame",
    vi.fn((id: number) => frames.delete(id))
  );
  const windowListeners = new Map<string, EventListener>();
  vi.stubGlobal("window", {
    devicePixelRatio: 2,
    setTimeout: vi.fn(() => 1),
    clearTimeout: vi.fn(),
    addEventListener: vi.fn((type: string, listener: EventListener) =>
      windowListeners.set(type, listener)
    ),
    removeEventListener: vi.fn((type: string) => windowListeners.delete(type)),
  });
  const observe = vi.fn();
  const disconnect = vi.fn();
  let resizeCallback: (() => void) | undefined;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        resizeCallback = callback;
      }
      observe = observe;
      disconnect = disconnect;
    }
  );
  return {
    chart,
    chartCanvas,
    context,
    disconnect,
    draw,
    elements,
    fireFrame() {
      const entry = frames.entries().next().value as [
        number,
        FrameRequestCallback
      ];
      frames.delete(entry[0]);
      entry[1](0);
    },
    idle,
    output,
    resize: () => resizeCallback?.(),
    root,
    shared,
  };
}

describe("MNIST browser lifecycle", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.guis.length = 0;
    mocks.charts.length = 0;
    mocks.guiDestroyError = undefined;
    mocks.guiNameError = undefined;
    mocks.guiNameHook = undefined;
  });
  afterEach(async () => {
    await vi.dynamicImportSettled();
    vi.unstubAllGlobals();
  });

  it("coalesces drawing updates, submits the final stroke, and releases pointer capture", () => {
    const context = fakeContext();
    const canvas = new FakeCanvas(context);
    const submit = vi.fn();
    const timers: (() => void)[] = [];
    const clearTimeout = vi.fn();
    vi.stubGlobal("window", {
      setTimeout: vi.fn((callback: () => void) => {
        timers.push(callback);
        return timers.length;
      }),
      clearTimeout,
    });
    const touchAction = canvas.style.touchAction;
    const drawing = installDrawing(
      canvas as unknown as HTMLCanvasElement,
      context as unknown as CanvasRenderingContext2D,
      submit
    );

    canvas.dispatch("pointerdown", { pointerId: 7 });
    canvas.dispatch("pointermove", { pointerId: 7, clientX: 80 });
    expect(timers).toHaveLength(1);
    expect(canvas.captured.has(7)).toBe(true);
    timers[0]!();
    expect(submit).toHaveBeenCalledOnce();

    canvas.dispatch("pointermove", { pointerId: 7, clientX: 100 });
    canvas.dispatch("pointerup", { pointerId: 7 });
    expect(submit).toHaveBeenCalledTimes(2);
    expect(clearTimeout).toHaveBeenCalled();
    expect(canvas.captured.has(7)).toBe(false);
    drawing.dispose();
    drawing.dispose();
    expect(
      [...canvas.listeners.values()].every((listeners) => listeners.size === 0)
    ).toBe(true);
    expect(canvas.style.touchAction).toBe(touchAction);
  });

  it("mounts lil-gui, classifies the seed, resizes, clears, and delegates teardown", async () => {
    const env = setup();
    const renderer = createRenderer(env.root);
    await renderer.ready;
    await vi.waitFor(() =>
      expect(env.shared.session.run).toHaveBeenCalledOnce()
    );
    await vi.waitFor(() =>
      expect(env.elements.get("status")?.textContent).toBe("inferences: 1")
    );

    const gui = mocks.guis[0]!;
    expect(gui.options).toMatchObject({
      container: env.root,
      title: "MNIST Classifier",
      width: 180,
    });
    expect(gui.controllers.map(({ label }) => label)).toEqual(["Clear"]);
    expect(gui.controllers[0]!.object[gui.controllers[0]!.property]).toBeTypeOf(
      "function"
    );
    expect(gui.domElement.style).toMatchObject({
      position: "absolute",
      right: "16px",
      top: "16px",
      zIndex: "10",
    });

    env.fireFrame();
    expect(env.output.resize).toHaveBeenCalledWith([800, 400]);
    gui.controllers[0]!.invoke();
    expect(env.context.fillRect).toHaveBeenLastCalledWith(0, 0, 280, 280);
    expect(env.chart).toHaveBeenLastCalledWith(
      env.shared.value.gpu,
      env.output,
      env.idle,
      false
    );

    renderer.dispose();
    renderer.dispose();
    await vi.waitFor(() =>
      expect(env.shared.value.release).toHaveBeenCalledOnce()
    );
    expect(gui.destroy).toHaveBeenCalledOnce();
    expect(env.disconnect).toHaveBeenCalledOnce();
    expect(env.idle.dispose).not.toHaveBeenCalled();
  });

  it("rolls back drawing and a partial lil-gui without masking its construction failure", () => {
    const primary = new Error("GUI name failed");
    const env = setup();
    mocks.guiNameHook = () =>
      env.draw.dispatch("pointerdown", { pointerId: 9 });
    mocks.guiNameError = primary;
    env.draw.removeError = {
      type: "pointerleave",
      error: new Error("drawing cleanup failed"),
    };
    mocks.guiDestroyError = new Error("GUI cleanup failed");

    let thrown: unknown;
    try {
      createRenderer(env.root);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(primary);
    expect(env.draw.captured.has(9)).toBe(false);
    expect(
      [...env.draw.listeners.values()].every(
        (listeners) => listeners.size === 0
      )
    ).toBe(true);
    expect(window.clearTimeout).toHaveBeenCalled();
    expect(mocks.guis[0]!.destroy).toHaveBeenCalledOnce();
    expect(mocks.createShared).not.toHaveBeenCalled();
  });

  it("drops stale generations, classifies only the newest pending drawing, and disposes tensors", async () => {
    const first = deferred<Record<string, unknown>>();
    const shared = fakeShared(() => first.promise);
    const env = setup({ shared });
    const renderer = createRenderer(env.root);
    await renderer.ready;
    await vi.waitFor(() => expect(shared.session.run).toHaveBeenCalledOnce());

    env.draw.dispatch("pointerdown", { pointerId: 2 });
    env.draw.dispatch("pointerup", { pointerId: 2 });
    env.draw.dispatch("pointerdown", { pointerId: 3, clientX: 100 });
    env.draw.dispatch("pointerup", { pointerId: 3 });
    const stale = { dispose: vi.fn() };
    first.resolve({ output: stale });
    shared.session.run.mockImplementationOnce(async () => {
      const latest = { dispose: vi.fn() };
      shared.outputs.push(latest);
      return { output: latest };
    });

    await vi.waitFor(() => expect(shared.session.run).toHaveBeenCalledTimes(2));
    await vi.waitFor(() =>
      expect(env.elements.get("status")?.textContent).toBe("inferences: 1")
    );
    expect(
      env.chart.mock.calls.filter((call) => call[3] === true)
    ).toHaveLength(1);
    expect(stale.dispose).toHaveBeenCalledOnce();
    expect(shared.inputs).toHaveLength(2);
    shared.inputs.forEach(({ dispose }) =>
      expect(dispose).toHaveBeenCalledOnce()
    );
    renderer.dispose();
  });

  it("disposes every returned tensor when the expected output is missing", async () => {
    const primary = new Error("missing expected output");
    const unexpected = { dispose: vi.fn() };
    const extra = { dispose: vi.fn() };
    const shared = fakeShared(async () => ({ unexpected, extra }));
    const env = setup({ shared });
    const callbacks = captureMicrotasks();
    mocks.assertGpuTensor.mockImplementation((tensor) => {
      if (!tensor) throw primary;
      return { size: 40 };
    });

    const renderer = createRenderer(env.root);
    await renderer.ready;
    await vi.waitFor(() => expect(shared.value.release).toHaveBeenCalledOnce());

    expect(mocks.assertGpuTensor).toHaveBeenCalledWith(undefined);
    expect(unexpected.dispose).toHaveBeenCalledOnce();
    expect(extra.dispose).toHaveBeenCalledOnce();
    expect(shared.inputs[0]!.dispose).toHaveBeenCalledOnce();
    expect(callbacks).toHaveLength(1);
    expect(callbacks[0]).toThrow(primary);
  });

  it("disposes the input after output cleanup fails and preserves the draw error", async () => {
    const primary = new Error("draw failed");
    const output = {
      dispose: vi.fn(() => {
        throw new Error("output cleanup failed");
      }),
    };
    const shared = fakeShared(async () => ({ output }));
    const env = setup({ shared });
    const callbacks = captureMicrotasks();
    mocks.withWrappedTensor.mockRejectedValue(primary);

    const renderer = createRenderer(env.root);
    await renderer.ready;
    await vi.waitFor(() => expect(shared.value.release).toHaveBeenCalledOnce());

    expect(output.dispose).toHaveBeenCalledOnce();
    expect(shared.inputs[0]!.dispose).toHaveBeenCalledOnce();
    expect(callbacks).toHaveLength(1);
    expect(callbacks[0]).toThrow(primary);
  });

  it("releases a session that arrives after disposal without creating GPU children", async () => {
    const pending = deferred<ReturnType<typeof fakeShared>["value"]>();
    const shared = fakeShared();
    const env = setup({ sharedPromise: pending.promise });
    const renderer = createRenderer(env.root);
    renderer.dispose();
    pending.resolve(shared.value);
    await renderer.ready;
    await vi.waitFor(() => expect(shared.value.release).toHaveBeenCalledOnce());
    expect(mocks.surface).not.toHaveBeenCalled();
  });

  it("preserves an initialization error through teardown", async () => {
    const primary = new Error("chart allocation failed");
    const env = setup();
    mocks.createChart.mockImplementation(() => {
      throw primary;
    });
    mocks.guiDestroyError = new Error("gui cleanup failed");
    const renderer = createRenderer(env.root);
    await expect(renderer.ready).rejects.toBe(primary);
    expect(env.shared.value.release).toHaveBeenCalledOnce();
    expect(mocks.guis[0]!.destroy).toHaveBeenCalledOnce();
  });

  it("tears down a live inference failure before exposing the exact error", async () => {
    const primary = new Error("inference failed");
    const shared = fakeShared(async () => {
      throw primary;
    });
    const env = setup({ shared });
    const callbacks = captureMicrotasks();
    mocks.guiDestroyError = new Error("gui cleanup failed");
    const renderer = createRenderer(env.root);
    await renderer.ready;
    await vi.waitFor(() => expect(shared.value.release).toHaveBeenCalledOnce());
    expect(env.elements.get("failure")?.hidden).toBe(false);
    expect(env.elements.get("failure-detail")?.textContent).toBe(
      primary.message
    );
    expect(shared.inputs[0]!.dispose).toHaveBeenCalledOnce();
    expect(callbacks).toHaveLength(1);
    expect(callbacks[0]).toThrow(primary);
  });
});
