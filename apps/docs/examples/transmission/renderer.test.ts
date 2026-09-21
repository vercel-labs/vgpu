import { afterEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  aspectOf: vi.fn(() => 2),
  cameraView: vi.fn(() => ({ view: true })),
  createScene: vi.fn(),
  init: vi.fn(),
  installInput: vi.fn(),
  normalizeControls: vi.fn((controls: Record<string, unknown>) => ({
    ...controls,
  })),
  renderScene: vi.fn(),
  replaceTargets: vi.fn(),
  surface: vi.fn(),
}));

const guiState = vi.hoisted(() => ({
  controllers: [] as Array<{
    args: unknown[];
    label?: string;
    object: Record<string, unknown>;
    property: string;
  }>,
  instances: [] as Array<{
    destroy: ReturnType<typeof vi.fn>;
    domElement: { style: Record<string, string> };
    options: Record<string, unknown>;
  }>,
}));

vi.mock("vgpu", () => ({ init: mocks.init, surface: mocks.surface }));
vi.mock("./camera", () => ({ cameraView: mocks.cameraView }));
vi.mock("./pointer-input", () => ({
  installOrbitInput: mocks.installInput,
}));
vi.mock("./scene", () => ({
  DEFAULT_CONTROLS: {
    dispersion: true,
    ior: 1.5,
    refraction: "double",
    roughness: 0.06,
  },
  aspectOf: mocks.aspectOf,
  createScene: mocks.createScene,
  normalizeControls: mocks.normalizeControls,
  renderScene: mocks.renderScene,
  replaceTargets: mocks.replaceTargets,
}));
vi.mock("lil-gui", () => ({
  default: class GUI {
    readonly destroy = vi.fn();
    readonly domElement = { style: {} as Record<string, string> };
    constructor(readonly options: Record<string, unknown>) {
      guiState.instances.push(this);
    }
    add(object: Record<string, unknown>, property: string, ...args: unknown[]) {
      const record: (typeof guiState.controllers)[number] = {
        args,
        object,
        property,
      };
      guiState.controllers.push(record);
      return {
        name(label: string) {
          record.label = label;
          return this;
        },
      };
    }
  },
}));

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
  let resizeCallback: (() => void) | undefined;
  const frames = new Map<number, FrameRequestCallback>();
  const page = { hidden: false };
  vi.stubGlobal("document", page);
  vi.stubGlobal("performance", { now: () => 1_000 });
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

  const parent = {} as HTMLElement;
  const canvas = { parentElement: parent } as HTMLCanvasElement;
  const unsubscribe = vi.fn();
  const output = {
    dispose: vi.fn(),
    format: "bgra8unorm",
    onResize: vi.fn((callback: () => void) => {
      resizeCallback = callback;
      callback();
      return unsubscribe;
    }),
    size: [400, 200] as [number, number],
  };
  const gpu = { dispose: vi.fn() };
  const scene = { scene: true };
  const input = {
    advance: vi.fn(),
    dispose: vi.fn(),
    pitch: 0.4,
    radius: 4.1,
    yaw: 1.2,
  };
  const normalizedControls = {
    dispersion: true,
    ior: 1.6,
    refraction: "double",
    roughness: 0.1,
  };
  mocks.aspectOf.mockReturnValue(2);
  mocks.cameraView.mockReturnValue({ view: true });
  mocks.normalizeControls.mockReturnValue(normalizedControls);
  mocks.init.mockResolvedValue(gpu);
  mocks.surface.mockReturnValue(output);
  mocks.createScene.mockResolvedValue(scene);
  mocks.installInput.mockReturnValue(input);
  mocks.renderScene.mockImplementation(
    (_gpu: unknown, _scene: unknown, _output: unknown, view: unknown) => {
      if (typeof view === "function") view();
    }
  );

  const fireFrame = (now = 1_100) => {
    const entry = frames.entries().next().value as
      | [number, FrameRequestCallback]
      | undefined;
    if (!entry) throw new Error("No animation frame is pending.");
    frames.delete(entry[0]);
    entry[1](now);
  };
  return {
    canvas,
    fireFrame,
    fireResize: () => resizeCallback?.(),
    frames,
    gpu,
    input,
    normalizedControls,
    output,
    page,
    parent,
    scene,
    unsubscribe,
  };
}

afterEach(async () => {
  await vi.dynamicImportSettled();
  guiState.controllers.length = 0;
  guiState.instances.length = 0;
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

test("mounts local lil-gui, renders, resizes, and delegates GPU teardown", async () => {
  const env = setup();
  const initialControls = {
    dispersion: false,
    ior: 9,
    refraction: "simple" as const,
    roughness: -2,
  };
  const renderer = createRenderer({
    canvas: env.canvas,
    initialControls,
  });
  await renderer.ready;

  expect(guiState.instances[0]?.options).toMatchObject({
    container: env.parent,
    title: "Transmission",
    width: 180,
  });
  expect(guiState.instances[0]?.domElement.style).toMatchObject({
    position: "absolute",
    right: "16px",
    top: "16px",
    zIndex: "10",
  });
  expect(mocks.normalizeControls).toHaveBeenCalledWith(initialControls);
  expect(
    guiState.controllers.every(
      ({ object }) => object === env.normalizedControls
    )
  ).toBe(true);
  expect(
    guiState.controllers.map(({ args, label, property }) => ({
      args,
      label,
      property,
    }))
  ).toEqual([
    { args: [1, 2.4, 0.01], label: "IOR", property: "ior" },
    { args: [0, 1, 0.01], label: "Roughness", property: "roughness" },
    { args: [], label: "Chromatic dispersion", property: "dispersion" },
    {
      args: [{ Double: "double", Simple: "simple" }],
      label: "Refraction",
      property: "refraction",
    },
  ]);
  expect(mocks.replaceTargets).not.toHaveBeenCalled();
  env.output.size = [600, 300];
  env.fireResize();
  expect(mocks.replaceTargets).toHaveBeenCalledWith(
    env.gpu,
    env.scene,
    env.output.size
  );

  Object.assign(env.normalizedControls, {
    dispersion: false,
    ior: 2.2,
    refraction: "simple",
    roughness: 0.7,
  });
  env.fireFrame();
  expect(env.input.advance).toHaveBeenCalledWith(0.1);
  expect(mocks.cameraView).toHaveBeenCalledWith(1.2, 0.4, 2, 4.1);
  const renderCall = mocks.renderScene.mock.calls[0];
  expect(renderCall?.slice(0, 4)).toEqual([
    env.gpu,
    env.scene,
    env.output,
    expect.any(Function),
  ]);
  expect(renderCall?.[4]).toBe(env.normalizedControls);
  expect(renderCall?.[4]).toEqual({
    dispersion: false,
    ior: 2.2,
    refraction: "simple",
    roughness: 0.7,
  });
  env.page.hidden = true;
  env.fireFrame(1_200);
  expect(mocks.renderScene).toHaveBeenCalledTimes(1);

  renderer.dispose();
  expect(env.unsubscribe).toHaveBeenCalledTimes(1);
  expect(env.input.dispose).toHaveBeenCalledTimes(1);
  expect(guiState.instances[0]?.destroy).toHaveBeenCalledTimes(1);
  expect(env.gpu.dispose).toHaveBeenCalledTimes(1);
  expect(env.output.dispose).not.toHaveBeenCalled();
  expect(env.frames.size).toBe(0);
});

test("disposes an initialization result that becomes stale", async () => {
  const env = setup();
  const pending = deferred<typeof env.gpu>();
  mocks.init.mockReturnValue(pending.promise);
  const renderer = createRenderer({ canvas: env.canvas });
  await vi.waitFor(() => expect(mocks.init).toHaveBeenCalled());
  renderer.dispose();
  pending.resolve(env.gpu);
  await renderer.ready;

  expect(env.gpu.dispose).toHaveBeenCalledTimes(1);
  expect(mocks.surface).not.toHaveBeenCalled();
});

test("disposes the GPU immediately while scene creation is pending", async () => {
  const env = setup();
  const pending = deferred<typeof env.scene>();
  mocks.createScene.mockReturnValue(pending.promise);
  const renderer = createRenderer({ canvas: env.canvas });
  await vi.waitFor(() => expect(mocks.createScene).toHaveBeenCalled());
  renderer.dispose();
  expect(env.gpu.dispose).toHaveBeenCalledTimes(1);
  pending.resolve(env.scene);
  await renderer.ready;

  expect(env.gpu.dispose).toHaveBeenCalledTimes(1);
  expect(mocks.installInput).not.toHaveBeenCalled();
  expect(guiState.instances).toHaveLength(0);
  expect(requestAnimationFrame).not.toHaveBeenCalled();
});

test("a late scene rejection after unmount resolves quietly", async () => {
  const env = setup();
  const pending = deferred<typeof env.scene>();
  mocks.createScene.mockReturnValue(pending.promise);
  const renderer = createRenderer({ canvas: env.canvas });
  await vi.waitFor(() => expect(mocks.createScene).toHaveBeenCalled());
  renderer.dispose();
  pending.reject(new Error("late compile failure"));

  await expect(renderer.ready).resolves.toBeUndefined();
  expect(env.gpu.dispose).toHaveBeenCalledTimes(1);
  expect(mocks.installInput).not.toHaveBeenCalled();
  expect(requestAnimationFrame).not.toHaveBeenCalled();
});

test("a late init rejection after unmount resolves quietly", async () => {
  const env = setup();
  const pending = deferred<typeof env.gpu>();
  mocks.init.mockReturnValue(pending.promise);
  const renderer = createRenderer({ canvas: env.canvas });
  await vi.waitFor(() => expect(mocks.init).toHaveBeenCalled());
  renderer.dispose();
  pending.reject(new Error("late init failure"));

  await expect(renderer.ready).resolves.toBeUndefined();
  expect(env.gpu.dispose).not.toHaveBeenCalled();
  expect(mocks.surface).not.toHaveBeenCalled();
});

test("preserves initialization errors when GPU cleanup also fails", async () => {
  const env = setup();
  const primary = new Error("compile failed");
  mocks.createScene.mockRejectedValue(primary);
  env.gpu.dispose.mockImplementation(() => {
    throw new Error("cleanup failed");
  });

  await expect(createRenderer({ canvas: env.canvas }).ready).rejects.toBe(
    primary
  );
  expect(env.gpu.dispose).toHaveBeenCalledTimes(1);
});

test("a live resize failure tears everything down without masking the error", async () => {
  const env = setup();
  const renderer = createRenderer({ canvas: env.canvas });
  await renderer.ready;
  const primary = new Error("resize failed");
  mocks.replaceTargets.mockImplementation(() => {
    throw primary;
  });
  env.input.dispose.mockImplementation(() => {
    throw new Error("input cleanup failed");
  });
  guiState.instances[0]?.destroy.mockImplementation(() => {
    throw new Error("GUI cleanup failed");
  });
  env.gpu.dispose.mockImplementation(() => {
    throw new Error("GPU cleanup failed");
  });

  expect(() => env.fireResize()).toThrow(primary);
  expect(env.unsubscribe).toHaveBeenCalledTimes(1);
  expect(env.input.dispose).toHaveBeenCalledTimes(1);
  expect(guiState.instances[0]?.destroy).toHaveBeenCalledTimes(1);
  expect(env.gpu.dispose).toHaveBeenCalledTimes(1);
  expect(env.frames.size).toBe(0);
  renderer.dispose();
});

test("a live render failure keeps the original error identity", async () => {
  const env = setup();
  const renderer = createRenderer({ canvas: env.canvas });
  await renderer.ready;
  const primary = new Error("render failed");
  mocks.renderScene.mockImplementation(() => {
    throw primary;
  });

  expect(() => env.fireFrame()).toThrow(primary);
  expect(env.unsubscribe).toHaveBeenCalledTimes(1);
  expect(env.input.dispose).toHaveBeenCalledTimes(1);
  expect(guiState.instances[0]?.destroy).toHaveBeenCalledTimes(1);
  expect(env.gpu.dispose).toHaveBeenCalledTimes(1);
  expect(env.frames.size).toBe(0);
  renderer.dispose();
});
