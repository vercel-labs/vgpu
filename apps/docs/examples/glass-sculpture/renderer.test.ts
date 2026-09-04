import { afterEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
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
    onChange?: () => void;
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
  installPointerInput: mocks.installInput,
}));
vi.mock("./scene", () => ({
  DEFAULT_CONTROLS: {
    dispersion: true,
    glass: "clear",
    light: "studio",
    renderScale: 0.75,
    shape: "gyroid",
    spin: true,
  },
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
      const controller = {
        name(label: string) {
          record.label = label;
          return controller;
        },
        onChange(callback: () => void) {
          record.onChange = callback;
          return controller;
        },
      };
      return controller;
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
    lightAzimuth: 0.7,
    lightElevation: 0.5,
    pitch: 0.4,
    radius: 4.1,
    yaw: 1.2,
  };
  const normalizedControls = {
    dispersion: true,
    glass: "cobalt",
    light: "noir",
    renderScale: 0.5,
    shape: "knot",
    spin: true,
  };
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
    glass: "rose" as const,
    light: "gel" as const,
    renderScale: 1 as const,
    shape: "droplets" as const,
    spin: false,
  };
  const renderer = createRenderer({ canvas: env.canvas, initialControls });
  await renderer.ready;

  expect(guiState.instances[0]?.options).toMatchObject({
    container: env.parent,
    title: "Glass sculpture",
    width: 200,
  });
  expect(guiState.instances[0]?.domElement.style).toMatchObject({
    position: "absolute",
    right: "16px",
    top: "16px",
    zIndex: "10",
  });
  expect(mocks.normalizeControls).toHaveBeenCalledWith(initialControls);
  expect(mocks.createScene).toHaveBeenCalledWith(
    env.gpu,
    env.output,
    env.normalizedControls
  );
  expect(
    guiState.controllers.every(
      ({ object }) => object === env.normalizedControls
    )
  ).toBe(true);
  expect(
    guiState.controllers.map(({ label, property }) => ({ label, property }))
  ).toEqual([
    { label: "Shape", property: "shape" },
    { label: "Glass", property: "glass" },
    { label: "Light rig", property: "light" },
    { label: "Dispersion", property: "dispersion" },
    { label: "Turntable", property: "spin" },
    { label: "Render scale", property: "renderScale" },
  ]);

  // The initial onResize fire must not rebuild targets; a real resize must.
  expect(mocks.replaceTargets).not.toHaveBeenCalled();
  env.output.size = [600, 300];
  env.fireResize();
  expect(mocks.replaceTargets).toHaveBeenCalledWith(
    env.gpu,
    env.scene,
    env.output.size,
    env.normalizedControls.renderScale
  );
  // Changing the render scale from the GUI rebuilds them too.
  env.normalizedControls.renderScale = 1;
  guiState.controllers.at(-1)?.onChange?.();
  expect(mocks.replaceTargets).toHaveBeenLastCalledWith(
    env.gpu,
    env.scene,
    env.output.size,
    1
  );

  env.fireFrame();
  expect(env.input.advance).toHaveBeenCalledWith(0.1);
  expect(mocks.cameraView).toHaveBeenCalledWith(1.2, 0.4, 4.1);
  const renderCall = mocks.renderScene.mock.calls[0];
  expect(renderCall?.slice(0, 4)).toEqual([
    env.gpu,
    env.scene,
    env.output,
    expect.any(Function),
  ]);
  expect(renderCall?.[4]).toBe(env.normalizedControls);
  expect(renderCall?.[5]).toEqual({
    clock: 0.1,
    light: { azimuth: 0.7, elevation: 0.5 },
    time: 0.1,
  });

  // Turning the turntable off freezes sculpture time but not the clock.
  env.normalizedControls.spin = false;
  env.fireFrame(1_200);
  expect(mocks.renderScene.mock.calls[1]?.[5]).toEqual({
    clock: 0.2,
    light: { azimuth: 0.7, elevation: 0.5 },
    time: 0.1,
  });

  env.page.hidden = true;
  env.fireFrame(1_300);
  expect(mocks.renderScene).toHaveBeenCalledTimes(2);

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

test("a live render failure tears everything down and keeps the error identity", async () => {
  const env = setup();
  const renderer = createRenderer({ canvas: env.canvas });
  await renderer.ready;
  const primary = new Error("render failed");
  mocks.renderScene.mockImplementation(() => {
    throw primary;
  });
  env.input.dispose.mockImplementation(() => {
    throw new Error("input cleanup failed");
  });

  expect(() => env.fireFrame()).toThrow(primary);
  expect(env.unsubscribe).toHaveBeenCalledTimes(1);
  expect(env.input.dispose).toHaveBeenCalledTimes(1);
  expect(guiState.instances[0]?.destroy).toHaveBeenCalledTimes(1);
  expect(env.gpu.dispose).toHaveBeenCalledTimes(1);
  expect(env.frames.size).toBe(0);
  renderer.dispose();
});
