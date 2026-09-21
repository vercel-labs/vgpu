import { afterEach, expect, test, vi } from "vitest";

const guiHarness = vi.hoisted(() => {
  const instances: Array<{
    options: unknown;
    domElement: { style: Record<string, string> };
    destroy: ReturnType<typeof vi.fn>;
    model?: Record<string, unknown>;
    property?: string;
    choices?: Record<string, number>;
    label?: string;
    change?: (value: unknown) => unknown;
  }> = [];
  const state: { constructorFailure?: unknown; addFailure?: unknown } = {};

  class FakeGui {
    options: unknown;
    domElement = { style: {} as Record<string, string> };
    destroy = vi.fn();
    model?: Record<string, unknown>;
    property?: string;
    choices?: Record<string, number>;
    label?: string;
    change?: (value: unknown) => unknown;

    constructor(options: unknown) {
      if (state.constructorFailure) throw state.constructorFailure;
      this.options = options;
      instances.push(this);
    }

    add(
      model: Record<string, unknown>,
      property: string,
      choices: Record<string, number>
    ) {
      this.model = model;
      this.property = property;
      this.choices = choices;
      if (state.addFailure) throw state.addFailure;
      const controller = {
        name: (label: string) => {
          this.label = label;
          return controller;
        },
        onChange: (change: (value: unknown) => unknown) => {
          this.change = change;
          return controller;
        },
      };
      return controller;
    }
  }

  return { FakeGui, instances, state };
});

const pipeline = vi.hoisted(() => ({
  createBlit: vi.fn(),
  createScene: vi.fn(),
  renderScene: vi.fn(),
}));

const vgpu = vi.hoisted(() => ({ init: vi.fn() }));

vi.mock("lil-gui", () => ({ default: guiHarness.FakeGui }));
vi.mock("./scene-pipeline", () => ({
  createBlit: pipeline.createBlit,
  createScene: pipeline.createScene,
  renderScene: pipeline.renderScene,
  DEFAULT_INSTANCE_COUNT: 50,
  INSTANCE_COUNT_OPTIONS: {
    "50³ (125k)": 50,
    "100³ (1M — stress test)": 100,
  },
  isInstanceCount: (value: number) => value === 50 || value === 100,
}));
vi.mock("vgpu", () => ({
  init: vgpu.init,
  clock: (gpu: TestGpu) => gpu.clock,
  frameLoop: (gpu: TestGpu, callback: (frame: unknown) => void) =>
    gpu.fns.frameLoop(callback),
  surface: (gpu: TestGpu, canvas: HTMLCanvasElement, options: unknown) =>
    gpu.fns.surface(canvas, options),
  target: (gpu: TestGpu, options: { size: readonly [number, number] }) =>
    gpu.fns.target(options),
}));

import { createRenderer } from "./renderer";

interface TestSurface {
  size: readonly [number, number];
  format: string;
  onResize(
    callback: (size: { width: number; height: number }) => unknown
  ): () => void;
}

interface TestTarget {
  size: readonly [number, number];
  format: string;
  destroy: ReturnType<typeof vi.fn<() => void>>;
}

type MakeSurface = (canvas: HTMLCanvasElement, options: unknown) => TestSurface;
type MakeTarget = (options: { size: readonly [number, number] }) => TestTarget;
type StartLoop = (callback: (frame: unknown) => void) => { stop(): void };

interface TestGpu {
  clock: { time: number };
  dispose: ReturnType<typeof vi.fn>;
  fns: {
    frameLoop: ReturnType<typeof vi.fn<StartLoop>>;
    surface: ReturnType<typeof vi.fn<MakeSurface>>;
    target: ReturnType<typeof vi.fn<MakeTarget>>;
  };
}

interface TestScene {
  id: string;
  geometry: { destroy: ReturnType<typeof vi.fn> };
  draw: object;
  bundle: object;
  extent: number;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeScene(id: string): TestScene {
  return {
    id,
    geometry: { destroy: vi.fn() },
    draw: {},
    bundle: {},
    extent: 32,
  };
}

function setup() {
  const container = {} as HTMLElement;
  const canvas = { parentElement: container } as HTMLCanvasElement;
  const targets: Array<{
    size: readonly [number, number];
    format: string;
    destroy: ReturnType<typeof vi.fn>;
  }> = [];
  const blits: Array<{
    source: unknown;
    compile: ReturnType<typeof vi.fn>;
  }> = [];
  const scenes: TestScene[] = [];
  let resize:
    | ((size: { width: number; height: number }) => unknown)
    | undefined;
  let frameCallback: ((frame: unknown) => void) | undefined;

  const unsubscribe = vi.fn();
  const stop = vi.fn();
  const output = {
    size: [100, 50] as const,
    format: "bgra8unorm",
    onResize: vi.fn((callback: typeof resize) => {
      resize = callback;
      return unsubscribe;
    }),
  };
  const gpu: TestGpu = {
    clock: { time: 2.4 },
    dispose: vi.fn(),
    fns: {
      surface: vi.fn<MakeSurface>(() => output),
      target: vi.fn<MakeTarget>((options) => {
        const next = {
          size: options.size,
          format: "rgba8unorm",
          destroy: vi.fn<() => void>(),
        };
        targets.push(next);
        return next;
      }),
      frameLoop: vi.fn<StartLoop>((callback) => {
        frameCallback = callback;
        return { stop };
      }),
    },
  };

  pipeline.createScene.mockImplementation(
    async (_gpu: unknown, _target: unknown, count: number) => {
      const next = makeScene(`scene-${count}-${scenes.length}`);
      next.extent = count * 0.64;
      scenes.push(next);
      return next;
    }
  );
  pipeline.createBlit.mockImplementation((_gpu: unknown, source: unknown) => {
    const next = { source, compile: vi.fn(async () => {}) };
    blits.push(next);
    return next;
  });
  vgpu.init.mockResolvedValue(gpu);

  return {
    blits,
    canvas,
    container,
    gpu,
    output,
    scenes,
    stop,
    targets,
    unsubscribe,
    emitResize: (width: number, height: number) => resize?.({ width, height }),
    renderFrame: () => frameCallback?.({ id: "frame" }),
  };
}

afterEach(() => {
  guiHarness.instances.length = 0;
  guiHarness.state.constructorFailure = undefined;
  guiHarness.state.addFailure = undefined;
  pipeline.createBlit.mockReset();
  pipeline.createScene.mockReset();
  pipeline.renderScene.mockReset();
  vgpu.init.mockReset();
});

test("mounts a container-scoped GUI with the exact default and stress choices", async () => {
  const env = setup();
  const renderer = createRenderer({
    canvas: env.canvas,
    container: env.container,
  });
  await renderer.ready;

  const gui = guiHarness.instances[0]!;
  expect(gui.options).toEqual({
    title: "Instanced Rendering",
    container: env.container,
    width: 210,
  });
  expect(gui.model).toEqual({ count: 50 });
  expect(gui.property).toBe("count");
  expect(gui.choices).toEqual({
    "50³ (125k)": 50,
    "100³ (1M — stress test)": 100,
  });
  expect(gui.label).toBe("Instances");
  expect(pipeline.createScene).toHaveBeenCalledWith(
    env.gpu,
    env.targets[0],
    50
  );

  expect(gui.change?.(75)).toBeUndefined();
  expect(pipeline.createScene).toHaveBeenCalledTimes(1);
  await gui.change?.(100);
  expect(pipeline.createScene).toHaveBeenLastCalledWith(
    env.gpu,
    env.targets[1],
    100
  );
  expect(env.scenes[0]!.geometry.destroy).toHaveBeenCalledOnce();
  expect(env.targets[0]!.destroy).toHaveBeenCalledOnce();

  env.renderFrame();
  expect(pipeline.renderScene).toHaveBeenCalledWith(
    { id: "frame" },
    env.scenes[1],
    env.blits[1],
    env.targets[1],
    env.output,
    2.4
  );
  renderer.dispose();
});

test("does not compile the blit against a Surface outside frame", async () => {
  const env = setup();
  const renderer = createRenderer({ canvas: env.canvas });
  await renderer.ready;

  expect(env.blits[0]!.compile).not.toHaveBeenCalled();
  env.renderFrame();
  expect(pipeline.renderScene).toHaveBeenCalledOnce();
  renderer.dispose();
});

test("50 to 100 to 50 invalidates and destroys the stale stress generation", async () => {
  const env = setup();
  const renderer = createRenderer({ canvas: env.canvas });
  await renderer.ready;
  const gui = guiHarness.instances[0]!;
  const stress = deferred<TestScene>();
  const staleScene = makeScene("stale-stress");
  pipeline.createScene.mockImplementationOnce(() => stress.promise);

  const staleBuild = gui.change?.(100) as Promise<void>;
  expect(gui.change?.(50)).toBeUndefined();
  stress.resolve(staleScene);
  await staleBuild;

  expect(staleScene.geometry.destroy).toHaveBeenCalledOnce();
  expect(env.targets[1]!.destroy).toHaveBeenCalledOnce();
  expect(env.scenes[0]!.geometry.destroy).not.toHaveBeenCalled();
  expect(env.targets[0]!.destroy).not.toHaveBeenCalled();

  const newest = makeScene("newest-stress");
  pipeline.createScene.mockResolvedValueOnce(newest);
  await gui.change?.(100);
  env.renderFrame();
  expect(pipeline.renderScene).toHaveBeenLastCalledWith(
    { id: "frame" },
    newest,
    env.blits[2],
    env.targets[2],
    env.output,
    2.4
  );
  renderer.dispose();
});

test("commits the replacement, attempts all retirement cleanup, then owner-fails exactly", async () => {
  const env = setup();
  const renderer = createRenderer({ canvas: env.canvas });
  await renderer.ready;
  const geometryFailure = new Error("old geometry retirement failed");
  const targetFailure = new Error("old target retirement failed");
  env.scenes[0]!.geometry.destroy.mockImplementationOnce(() => {
    throw geometryFailure;
  });
  env.targets[0]!.destroy.mockImplementationOnce(() => {
    throw targetFailure;
  });

  await expect(guiHarness.instances[0]!.change?.(100)).rejects.toBe(
    geometryFailure
  );

  expect(pipeline.createScene).toHaveBeenCalledTimes(2);
  expect(env.scenes[0]!.geometry.destroy).toHaveBeenCalledOnce();
  expect(env.targets[0]!.destroy).toHaveBeenCalledOnce();
  expect(env.scenes[1]!.geometry.destroy).not.toHaveBeenCalled();
  expect(env.targets[1]!.destroy).not.toHaveBeenCalled();
  expect(env.stop).toHaveBeenCalledOnce();
  expect(env.unsubscribe).toHaveBeenCalledOnce();
  expect(guiHarness.instances[0]!.destroy).toHaveBeenCalledOnce();
  expect(env.gpu.dispose).toHaveBeenCalledOnce();
  env.renderFrame();
  expect(pipeline.renderScene).not.toHaveBeenCalled();
});

test("commits only the latest complete resize generation", async () => {
  const env = setup();
  const renderer = createRenderer({ canvas: env.canvas });
  await renderer.ready;
  const first = deferred<TestScene>();
  const firstScene = makeScene("first-resize");
  const secondScene = makeScene("second-resize");
  pipeline.createScene
    .mockImplementationOnce(() => first.promise)
    .mockResolvedValueOnce(secondScene);

  const staleResize = env.emitResize(200, 100) as Promise<void>;
  const latestResize = env.emitResize(300, 150) as Promise<void>;
  await latestResize;
  first.resolve(firstScene);
  await staleResize;

  expect(env.targets.map((value) => value.size)).toEqual([
    [100, 50],
    [200, 100],
    [300, 150],
  ]);
  expect(firstScene.geometry.destroy).toHaveBeenCalledOnce();
  expect(env.targets[1]!.destroy).toHaveBeenCalledOnce();
  expect(env.scenes[0]!.geometry.destroy).toHaveBeenCalledOnce();
  expect(env.targets[0]!.destroy).toHaveBeenCalledOnce();
  expect(secondScene.geometry.destroy).not.toHaveBeenCalled();

  env.renderFrame();
  expect(pipeline.renderScene).toHaveBeenLastCalledWith(
    { id: "frame" },
    secondScene,
    env.blits[1],
    env.targets[2],
    env.output,
    2.4
  );
  renderer.dispose();
});

test("prepares the scene before the blit and preserves a synchronous primary failure", async () => {
  const env = setup();
  const primary = new Error("scene allocation failed");
  const cleanup = new Error("candidate cleanup failed");
  pipeline.createScene.mockImplementationOnce(() => {
    throw primary;
  });
  env.gpu.fns.target.mockImplementationOnce(
    (options: { size: readonly [number, number] }) => {
      const candidate = {
        size: options.size,
        format: "rgba8unorm",
        destroy: vi.fn(() => {
          throw cleanup;
        }),
      };
      env.targets.push(candidate);
      return candidate;
    }
  );

  const renderer = createRenderer({ canvas: env.canvas });
  await expect(renderer.ready).rejects.toBe(primary);
  expect(pipeline.createBlit).not.toHaveBeenCalled();
  expect(env.targets[0]!.destroy).toHaveBeenCalledOnce();
  expect(env.gpu.dispose).toHaveBeenCalledOnce();
});

test("a live resize failure tears down and remains observable by exact identity", async () => {
  const env = setup();
  const renderer = createRenderer({ canvas: env.canvas });
  await renderer.ready;
  const failure = new Error("resize scene failed");
  pipeline.createScene.mockRejectedValueOnce(failure);

  await expect(env.emitResize(220, 110)).rejects.toBe(failure);
  expect(env.targets[1]!.destroy).toHaveBeenCalledOnce();
  expect(env.stop).toHaveBeenCalledOnce();
  expect(env.unsubscribe).toHaveBeenCalledOnce();
  expect(guiHarness.instances[0]!.destroy).toHaveBeenCalledOnce();
  expect(env.gpu.dispose).toHaveBeenCalledOnce();
  expect(env.scenes[0]!.geometry.destroy).not.toHaveBeenCalled();
});

test("rolls back a partially configured GUI and preserves its failure", async () => {
  const env = setup();
  const failure = new Error("GUI controller failed");
  guiHarness.state.addFailure = failure;
  const renderer = createRenderer({ canvas: env.canvas });

  await expect(renderer.ready).rejects.toBe(failure);
  expect(guiHarness.instances[0]!.destroy).toHaveBeenCalledOnce();
  expect(env.gpu.dispose).toHaveBeenCalledOnce();
  expect(env.scenes[0]!.geometry.destroy).not.toHaveBeenCalled();
  expect(env.targets[0]!.destroy).not.toHaveBeenCalled();
});

test("dispose is idempotent, attempts every cleanup, and delegates VGPU children", async () => {
  const env = setup();
  const renderer = createRenderer({ canvas: env.canvas });
  await renderer.ready;
  const stopFailure = new Error("stop failed");
  env.stop.mockImplementationOnce(() => {
    throw stopFailure;
  });

  expect(() => renderer.dispose()).not.toThrow();
  expect(env.unsubscribe).toHaveBeenCalledOnce();
  expect(guiHarness.instances[0]!.destroy).toHaveBeenCalledOnce();
  expect(env.gpu.dispose).toHaveBeenCalledOnce();
  expect(env.scenes[0]!.geometry.destroy).not.toHaveBeenCalled();
  expect(env.targets[0]!.destroy).not.toHaveBeenCalled();
  expect(() => renderer.dispose()).not.toThrow();
  expect(env.gpu.dispose).toHaveBeenCalledOnce();
});

test("a frame failure tears down and throws the same object", async () => {
  const env = setup();
  const renderer = createRenderer({ canvas: env.canvas });
  await renderer.ready;
  const failure = new Error("frame failed");
  pipeline.renderScene.mockImplementationOnce(() => {
    throw failure;
  });

  expect(() => env.renderFrame()).toThrow(failure);
  expect(env.stop).toHaveBeenCalledOnce();
  expect(env.unsubscribe).toHaveBeenCalledOnce();
  expect(guiHarness.instances[0]!.destroy).toHaveBeenCalledOnce();
  expect(env.gpu.dispose).toHaveBeenCalledOnce();
  expect(() => renderer.dispose()).not.toThrow();
});

test("intentional cancellation is quiet and disposes a late GPU exactly once", async () => {
  const env = setup();
  const pendingGpu = deferred<TestGpu>();
  vgpu.init.mockReturnValueOnce(pendingGpu.promise);
  const renderer = createRenderer({ canvas: env.canvas });
  await vi.waitFor(() => expect(vgpu.init).toHaveBeenCalledOnce());
  renderer.dispose();
  pendingGpu.resolve(env.gpu);

  await expect(renderer.ready).resolves.toBeUndefined();
  expect(env.gpu.dispose).toHaveBeenCalledOnce();
  expect(guiHarness.instances).toHaveLength(0);
});
