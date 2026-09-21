import { afterEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({ init: vi.fn() }));
const guiMocks = vi.hoisted(() => ({
  add: vi.fn(),
  changes: new Map<string, (value: any) => void>(),
  construct: vi.fn(),
  destroy: vi.fn(),
  updateDisplay: vi.fn(),
}));
const vgpuFns = vi.hoisted(() =>
  Object.fromEntries(
    [
      "surface",
      "target",
      "effect",
      "draw",
      "geometry",
      "sampler",
      "frame",
      "frameLoop",
    ].map((name) => [
      name,
      (gpu: any, ...args: any[]) => gpu.fns[name](...args),
    ])
  )
);

vi.mock("vgpu", () => ({
  init: mocks.init,
  ...vgpuFns,
  clock: (gpu: any) => gpu.clock,
}));
vi.mock("lil-gui", () => ({
  default: class MockGui {
    domElement = { style: {} };

    constructor(options: unknown) {
      guiMocks.construct(options);
    }

    add(object: object, property: string, ...args: unknown[]) {
      guiMocks.add(object, property, ...args);
      const controller = {
        name: vi.fn(() => controller),
        onChange: vi.fn((change: (value: any) => void) => {
          guiMocks.changes.set(property, change);
          return controller;
        }),
        updateDisplay: guiMocks.updateDisplay,
      };
      return controller;
    }

    destroy() {
      guiMocks.destroy();
    }
  },
}));

import { renderThumbnail } from "./render-thumbnail";
import { createMaps, createRenderer, createScene } from "./renderer";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function setup(options: { compileFailure?: Error } = {}) {
  const canvasListeners = new Map<string, EventListener>();
  const windowListeners = new Map<string, EventListener>();
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
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
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe = vi.fn();
      disconnect = disconnect;
    }
  );

  const captured = new Set<number>();
  const container = {} as HTMLElement;
  const canvas = {
    parentElement: container,
    style: { touchAction: "pan-y" },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 200, height: 100 }),
    addEventListener: vi.fn((name: string, listener: EventListener) => {
      canvasListeners.set(name, listener);
    }),
    removeEventListener: vi.fn((name: string) => canvasListeners.delete(name)),
    setPointerCapture: vi.fn((id: number) => captured.add(id)),
    hasPointerCapture: vi.fn((id: number) => captured.has(id)),
    releasePointerCapture: vi.fn((id: number) => captured.delete(id)),
  } as unknown as HTMLCanvasElement;

  const targets: any[] = [];
  const geometries: Array<{ destroy: ReturnType<typeof vi.fn> }> = [];
  const programs: Array<{
    set: ReturnType<typeof vi.fn>;
    compile: ReturnType<typeof vi.fn>;
  }> = [];
  const makeProgram = () => {
    const program = {
      set: vi.fn(),
      compile: options.compileFailure
        ? vi.fn(async () => {
            throw options.compileFailure;
          })
        : vi.fn(async () => {}),
    };
    programs.push(program);
    return program;
  };
  const makeTarget = ({ size, format = "rgba16float" }: any) => {
    const value = {
      size: [...size],
      texelSize: [1 / size[0], 1 / size[1]],
      format,
      resize: vi.fn((next: readonly [number, number]) => {
        value.size = [...next];
        value.texelSize = [1 / next[0], 1 / next[1]];
      }),
      destroy: vi.fn(),
    };
    targets.push(value);
    return value;
  };

  const surface = { size: [200, 100], format: "bgra8unorm", dispose: vi.fn() };
  const stop = vi.fn();
  let liveFrame:
    | ((frame: { pass: ReturnType<typeof vi.fn> }) => void)
    | undefined;
  const gpu = {
    clock: { time: 1.2, deltaTime: 1 / 60 },
    gpu: { queue: { onSubmittedWorkDone: vi.fn(async () => {}) } },
    settled: vi.fn(async () => {}),
    dispose: vi.fn(),
    fns: {
      surface: vi.fn(() => surface),
      target: vi.fn(makeTarget),
      effect: vi.fn(makeProgram),
      draw: vi.fn(makeProgram),
      geometry: vi.fn(() => {
        const value = { destroy: vi.fn() };
        geometries.push(value);
        return value;
      }),
      sampler: vi.fn(() => ({})),
      frame: vi.fn((encode: (frame: { pass: Function }) => void) => {
        encode({
          pass: (_options: unknown, draw: Function) => draw({ draw: vi.fn() }),
        });
      }),
      frameLoop: vi.fn((callback: NonNullable<typeof liveFrame>) => {
        liveFrame = callback;
        return { stop };
      }),
    },
  };
  mocks.init.mockResolvedValueOnce(gpu);

  const flushResize = () => {
    const entry = frames.entries().next().value as
      | [number, FrameRequestCallback]
      | undefined;
    if (!entry) throw new Error("No resize frame is pending.");
    frames.delete(entry[0]);
    entry[1](16);
  };

  return {
    canvas,
    canvasListeners,
    container,
    disconnect,
    flushResize,
    geometries,
    gpu,
    programs,
    runFrame: (currentFrame = { pass: vi.fn() }) => liveFrame?.(currentFrame),
    stop,
    surface,
    targets,
    windowListeners,
  };
}

afterEach(() => {
  guiMocks.changes.clear();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

test("mounts lil-gui, handles input and resize, and delegates VGPU teardown", async () => {
  const env = setup();
  const renderer = createRenderer({ canvas: env.canvas });
  await renderer.ready;

  expect(guiMocks.construct).toHaveBeenCalledWith({
    title: "Earth",
    container: env.container,
    width: 180,
  });
  const controlModel = guiMocks.add.mock.calls[0][0] as any;
  guiMocks.changes.get("sunDegrees")?.(180);
  expect(controlModel.autoRotate).toBe(false);
  expect(guiMocks.updateDisplay).toHaveBeenCalledOnce();
  env.runFrame();

  env.canvasListeners.get("pointerdown")?.({
    isPrimary: true,
    pointerId: 7,
    clientX: 10,
    clientY: 20,
  } as unknown as Event);
  expect(env.canvas.setPointerCapture).toHaveBeenCalledWith(7);
  env.flushResize();
  for (const target of env.targets.slice(2)) {
    expect(target.resize).toHaveBeenCalledOnce();
  }

  renderer.dispose();
  renderer.dispose();
  expect(guiMocks.destroy).toHaveBeenCalledOnce();
  expect(env.disconnect).toHaveBeenCalledOnce();
  expect(env.canvas.releasePointerCapture).toHaveBeenCalledWith(7);
  expect(env.canvas.style.touchAction).toBe("pan-y");
  expect(env.canvasListeners.size).toBe(0);
  expect(env.windowListeners.size).toBe(0);
  expect(env.gpu.dispose).toHaveBeenCalledOnce();
  expect(env.stop).not.toHaveBeenCalled();
  expect(env.surface.dispose).not.toHaveBeenCalled();
  for (const target of env.targets)
    expect(target.destroy).not.toHaveBeenCalled();
  for (const mesh of env.geometries)
    expect(mesh.destroy).not.toHaveBeenCalled();
});

test("disposes a GPU that resolves after initialization is cancelled", async () => {
  const env = setup();
  const init = deferred<typeof env.gpu>();
  mocks.init.mockReset().mockReturnValueOnce(init.promise);
  const renderer = createRenderer({ canvas: env.canvas });
  await vi.waitFor(() => expect(mocks.init).toHaveBeenCalledOnce());

  renderer.dispose();
  init.resolve(env.gpu);
  await renderer.ready;

  expect(env.gpu.dispose).toHaveBeenCalledOnce();
  expect(env.gpu.fns.surface).not.toHaveBeenCalled();
});

test("tears down the owned GPU when prewarm fails", async () => {
  const failure = new Error("compile failed");
  const env = setup({ compileFailure: failure });
  const renderer = createRenderer({ canvas: env.canvas });

  await expect(renderer.ready).rejects.toBe(failure);
  expect(env.gpu.dispose).toHaveBeenCalledOnce();
  expect(guiMocks.construct).not.toHaveBeenCalled();
  expect(env.surface.dispose).not.toHaveBeenCalled();
  for (const target of env.targets)
    expect(target.destroy).not.toHaveBeenCalled();
});

test.each(["uniforms", "render"] as const)(
  "live %s failure disposes browser ownership and preserves error identity",
  async (stage) => {
    const env = setup();
    const renderer = createRenderer({ canvas: env.canvas });
    await renderer.ready;
    const failure = new Error(`${stage} failed`);
    const currentFrame = { pass: vi.fn() };
    if (stage === "uniforms") {
      env.programs[0]!.set.mockImplementationOnce(() => {
        throw failure;
      });
    } else {
      currentFrame.pass.mockImplementationOnce(() => {
        throw failure;
      });
    }

    let caught: unknown;
    try {
      env.runFrame(currentFrame);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(failure);
    expect(guiMocks.destroy).toHaveBeenCalledOnce();
    expect(env.disconnect).toHaveBeenCalledOnce();
    expect(env.canvasListeners.size).toBe(0);
    expect(env.windowListeners.size).toBe(0);
    expect(env.gpu.dispose).toHaveBeenCalledOnce();
    expect(env.surface.dispose).not.toHaveBeenCalled();
    for (const target of env.targets)
      expect(target.destroy).not.toHaveBeenCalled();
    for (const geometry of env.geometries)
      expect(geometry.destroy).not.toHaveBeenCalled();
  }
);

test("map construction rolls back partial targets without masking its allocation error", () => {
  const env = setup();
  const failure = new Error("cloud target failed");
  const cleanupFailure = new Error("surface cleanup failed");
  const allocateTarget = env.gpu.fns.target.getMockImplementation()!;
  let calls = 0;
  env.gpu.fns.target.mockImplementation((options: any) => {
    if (++calls === 2) throw failure;
    const value = allocateTarget(options);
    value.destroy.mockImplementationOnce(() => {
      throw cleanupFailure;
    });
    return value;
  });

  let caught: unknown;
  try {
    createMaps(env.gpu as never);
  } catch (error) {
    caught = error;
  }

  expect(caught).toBe(failure);
  expect(env.targets).toHaveLength(1);
  expect(env.targets[0].destroy).toHaveBeenCalledOnce();
});

test("scene construction rolls back every geometry and preserves its program error", () => {
  const env = setup();
  const failure = new Error("sky effect failed");
  const cleanupFailure = new Error("atmosphere cleanup failed");
  env.gpu.fns.effect.mockImplementationOnce(() => {
    env.geometries[1]!.destroy.mockImplementationOnce(() => {
      throw cleanupFailure;
    });
    throw failure;
  });

  let caught: unknown;
  try {
    createScene(env.gpu as never);
  } catch (error) {
    caught = error;
  }

  expect(caught).toBe(failure);
  expect(env.geometries).toHaveLength(2);
  for (const geometry of env.geometries)
    expect(geometry.destroy).toHaveBeenCalledOnce();
});

test("thumbnail setup rolls back prior graphs and partial targets without masking allocation error", async () => {
  const env = setup();
  const failure = new Error("bloom target failed");
  const cleanupFailure = new Error("planet cleanup failed");
  const allocateTarget = env.gpu.fns.target.getMockImplementation()!;
  let calls = 0;
  env.gpu.fns.target.mockImplementation((options: any) => {
    if (++calls === 5) throw failure;
    const value = allocateTarget(options);
    if (calls === 4) {
      value.destroy.mockImplementationOnce(() => {
        throw cleanupFailure;
      });
    }
    return value;
  });

  const output = { size: [160, 90], format: "rgba8unorm" };
  await expect(renderThumbnail(env.gpu as never, output as never)).rejects.toBe(
    failure
  );

  expect(env.targets).toHaveLength(4);
  for (const target of env.targets)
    expect(target.destroy).toHaveBeenCalledOnce();
  for (const geometry of env.geometries)
    expect(geometry.destroy).toHaveBeenCalledOnce();
  expect(env.gpu.gpu.queue.onSubmittedWorkDone).toHaveBeenCalledOnce();
  expect(env.gpu.settled).toHaveBeenCalledOnce();
  expect(env.gpu.dispose).not.toHaveBeenCalled();
});

test.each(["queue", "settled"] as const)(
  "thumbnail cleanup waits when %s finishes before the other shared-GPU barrier",
  async (firstBarrier) => {
    const failure = new Error("compile failed");
    const env = setup({ compileFailure: failure });
    const barriers = {
      queue: deferred<void>(),
      settled: deferred<void>(),
    };
    env.gpu.gpu.queue.onSubmittedWorkDone.mockReturnValueOnce(
      barriers.queue.promise
    );
    env.gpu.settled.mockReturnValueOnce(barriers.settled.promise);
    const output = { size: [160, 90], format: "rgba8unorm" };
    const rendering = renderThumbnail(env.gpu as never, output as never);

    await vi.waitFor(() => {
      expect(env.gpu.gpu.queue.onSubmittedWorkDone).toHaveBeenCalledOnce();
      expect(env.gpu.settled).toHaveBeenCalledOnce();
    });
    for (const target of env.targets)
      expect(target.destroy).not.toHaveBeenCalled();
    for (const mesh of env.geometries)
      expect(mesh.destroy).not.toHaveBeenCalled();

    barriers[firstBarrier].resolve();
    await barriers[firstBarrier].promise;
    await Promise.resolve();
    for (const target of env.targets)
      expect(target.destroy).not.toHaveBeenCalled();
    for (const mesh of env.geometries)
      expect(mesh.destroy).not.toHaveBeenCalled();

    const lastBarrier = firstBarrier === "queue" ? "settled" : "queue";
    barriers[lastBarrier].resolve();
    await expect(rendering).rejects.toBe(failure);
    for (const target of env.targets)
      expect(target.destroy).toHaveBeenCalledOnce();
    for (const mesh of env.geometries)
      expect(mesh.destroy).toHaveBeenCalledOnce();
  }
);

test("thumbnail drain failures do not mask the primary shared-GPU error", async () => {
  const failure = new Error("compile failed");
  const env = setup({ compileFailure: failure });
  env.gpu.gpu.queue.onSubmittedWorkDone.mockImplementationOnce(() => {
    throw new Error("queue drain failed");
  });
  env.gpu.settled.mockRejectedValueOnce(new Error("settling failed"));
  const output = { size: [160, 90], format: "rgba8unorm" };

  await expect(renderThumbnail(env.gpu as never, output as never)).rejects.toBe(
    failure
  );

  expect(env.gpu.gpu.queue.onSubmittedWorkDone).toHaveBeenCalledOnce();
  expect(env.gpu.settled).toHaveBeenCalledOnce();
  for (const target of env.targets)
    expect(target.destroy).toHaveBeenCalledOnce();
  for (const mesh of env.geometries)
    expect(mesh.destroy).toHaveBeenCalledOnce();
  expect(env.gpu.dispose).not.toHaveBeenCalled();
});
