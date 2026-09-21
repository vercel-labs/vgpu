import { afterEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createScene: vi.fn(),
  draw: vi.fn(),
  frame: vi.fn(),
  geometry: vi.fn(),
  init: vi.fn(),
  loadAssets: vi.fn(),
  renderScene: vi.fn(),
  resizeScene: vi.fn(),
  setSettings: vi.fn(),
  surface: vi.fn(),
}));

const guiState = vi.hoisted(() => ({
  instances: [] as Array<{
    destroy: ReturnType<typeof vi.fn>;
    options: Record<string, unknown>;
  }>,
  properties: [] as string[],
}));

vi.mock("vgpu", () => ({
  draw: mocks.draw,
  frame: mocks.frame,
  geometry: mocks.geometry,
  init: mocks.init,
  surface: mocks.surface,
}));

vi.mock("vgpu/scene", () => ({
  perspectiveCamera: vi.fn(() => ({
    viewProjectionMatrix: new Float32Array(16),
  })),
  sphere: vi.fn(() => ({ sphere: true })),
}));

vi.mock("./hero-glass-assets", () => ({
  loadHeroGlassAssets: mocks.loadAssets,
}));

vi.mock("./scene", () => ({
  createCameraControls: vi.fn(() => ({
    fov: 20,
    maxMouseRotation: 5,
    mouseLerp: 0.02,
    position: [5.44, 1.33, 0.55],
    target: [0, 0.16, 0],
    up: [0, 1, 0],
  })),
  createHeroFractalScene: mocks.createScene,
  HERO_FLOOR_AO_DEFAULTS: {
    glassAoScale: 0.54,
    glassAoAmplitude: 0.41,
    glassAoOpacity: 0.11,
    fractalAoScale: 0.88,
    fractalAoAmplitude: 0.18,
    fractalAoOpacity: 0.57,
    orbAoScale: 0.58,
    orbAoAmplitude: 0.59,
    orbAoOpacity: 0.73,
  },
  modelMatrix: vi.fn(() => new Float32Array(16)),
  renderHeroFractalScene: mocks.renderScene,
  resizeHeroFractalScene: mocks.resizeScene,
  setHeroFractalSceneSettings: mocks.setSettings,
}));

vi.mock("lil-gui", () => {
  class Controller {
    constructor(private readonly property: string) {}
    name() {
      return this;
    }
    onChange(callback: (value: string) => void) {
      void callback;
      return this;
    }
    updateDisplay() {
      return this;
    }
  }

  class Folder {
    add(object: Record<string, unknown>, property: string) {
      void object;
      guiState.properties.push(property);
      return new Controller(property);
    }
    addColor(object: Record<string, unknown>, property: string) {
      void object;
      return new Controller(property);
    }
  }

  return {
    default: class GUI extends Folder {
      readonly destroy = vi.fn();
      readonly domElement = {
        dataset: {} as Record<string, string>,
        style: {} as Record<string, string>,
      };
      constructor(readonly options: Record<string, unknown>) {
        super();
        guiState.instances.push(this);
      }
      addFolder() {
        return new Folder();
      }
      close() {}
      onChange() {}
    },
  };
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

function setup(options: { reducedMotion?: boolean } = {}) {
  let now = 0;
  let nextFrame = 0;
  let rect = { width: 200, height: 100 };
  let resizeCallback: ResizeObserverCallback | undefined;
  let intersectionCallback: IntersectionObserverCallback | undefined;
  const frames = new Map<number, FrameRequestCallback>();
  const windowListeners = new Map<string, EventListener>();
  const documentListeners = new Map<string, EventListener>();
  const page = {
    hidden: false,
    addEventListener: vi.fn((name: string, listener: EventListener) => {
      documentListeners.set(name, listener);
    }),
    removeEventListener: vi.fn((name: string) => {
      documentListeners.delete(name);
    }),
  };
  vi.stubGlobal("document", page);
  vi.stubGlobal("performance", { now: () => now });
  vi.stubGlobal("window", {
    addEventListener: vi.fn((name: string, listener: EventListener) => {
      windowListeners.set(name, listener);
    }),
    devicePixelRatio: 2,
    innerHeight: 200,
    innerWidth: 400,
    location: { search: "" },
    matchMedia: vi.fn(() => ({ matches: options.reducedMotion ?? false })),
    removeEventListener: vi.fn((name: string) => {
      windowListeners.delete(name);
    }),
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
  const resizeDisconnect = vi.fn();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: ResizeObserverCallback) {
        resizeCallback = callback;
      }
      observe = vi.fn();
      disconnect = resizeDisconnect;
    }
  );
  const intersectionDisconnect = vi.fn();
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: IntersectionObserverCallback) {
        intersectionCallback = callback;
      }
      observe = vi.fn();
      disconnect = intersectionDisconnect;
    }
  );

  const parent = {} as HTMLElement;
  const canvas = {
    getBoundingClientRect: () => rect,
    parentElement: parent,
  } as unknown as HTMLCanvasElement;
  const canvasSurface = {
    format: "bgra8unorm",
    resize: vi.fn((size: readonly [number, number]) => {
      canvasSurface.size = [...size] as [number, number];
    }),
    size: [400, 200] as [number, number],
  };
  const gpu = { dispose: vi.fn() };
  const assets = {
    dispose: vi.fn(),
    environmentView: {},
    fractalGeometry: {},
    fractalMeshMax: [1, 1, 1],
    fractalMeshMin: [-1, -1, -1],
    fractalWireframeGeometry: {},
    geometry: {},
    meshMax: [1, 1, 1],
    meshMin: [-1, -1, -1],
    wireframeGeometry: {},
  };
  const scene = {
    environmentSampler: {},
    targets: { interior: {} },
  };
  const draws: Array<{
    compile: ReturnType<typeof vi.fn>;
    set: ReturnType<typeof vi.fn>;
  }> = [];

  mocks.init.mockResolvedValue(gpu);
  mocks.surface.mockReturnValue(canvasSurface);
  mocks.loadAssets.mockResolvedValue(assets);
  mocks.createScene.mockResolvedValue(scene);
  mocks.geometry.mockImplementation(() => ({}));
  mocks.draw.mockImplementation(() => {
    const value = {
      compile: vi.fn(async () => value),
      set: vi.fn(() => value),
    };
    draws.push(value);
    return value;
  });
  mocks.setSettings.mockReturnValue({
    cameraPosition: [5, 1, 0],
    environmentRotation: new Float32Array(16),
    fractalModel: new Float32Array(16),
    sphereMix: 0,
    time: 0,
    viewProjection: new Float32Array(16),
  });
  mocks.frame.mockImplementation(
    (_gpu: unknown, callback: (frame: unknown) => void) =>
      callback({
        pass: (_options: unknown, encode: (pass: unknown) => void) =>
          encode({ draw: vi.fn() }),
      })
  );

  const fireFrame = (time: number) => {
    now = time;
    const entry = frames.entries().next().value as
      | [number, FrameRequestCallback]
      | undefined;
    if (!entry) throw new Error("No animation frame is pending.");
    frames.delete(entry[0]);
    entry[1](time);
  };

  return {
    assets,
    canvas,
    canvasSurface,
    documentListeners,
    draws,
    fireFrame,
    fireIntersection(value: boolean) {
      intersectionCallback?.(
        [{ isIntersecting: value } as IntersectionObserverEntry],
        {} as IntersectionObserver
      );
    },
    fireResize() {
      resizeCallback?.([], {} as ResizeObserver);
    },
    frames,
    gpu,
    intersectionDisconnect,
    page,
    parent,
    resizeDisconnect,
    scene,
    setRect(width: number, height: number) {
      rect = { width, height };
    },
    windowListeners,
  };
}

afterEach(async () => {
  await vi.dynamicImportSettled();
  guiState.instances.length = 0;
  guiState.properties.length = 0;
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

test("mounts container-scoped lil-gui and delegates owned teardown", async () => {
  const env = setup();
  const renderer = createRenderer({ canvas: env.canvas });
  await renderer.ready;

  expect(mocks.loadAssets.mock.calls[0]?.[1]).toBeInstanceOf(AbortSignal);
  expect(guiState.instances[0]?.options.container).toBe(env.parent);
  expect(guiState.instances[0]?.options.title).toBe("Glass fractal material");
  expect(guiState.properties).not.toContain("shape");
  expect(mocks.renderScene).toHaveBeenCalled();
  expect(mocks.setSettings.mock.calls.at(-1)?.[3]).toMatchObject({
    floorGrid: false,
    morphDirection: 1,
    reflectionDebug: false,
    view: { pointer: [0, 0] },
  });

  renderer.dispose();
  renderer.dispose();
  expect(env.gpu.dispose).toHaveBeenCalledTimes(1);
  expect(env.assets.dispose).not.toHaveBeenCalled();
  expect(guiState.instances[0]?.destroy).toHaveBeenCalledTimes(1);
  expect(env.resizeDisconnect).toHaveBeenCalledTimes(1);
  expect(env.intersectionDisconnect).toHaveBeenCalledTimes(1);
  expect(env.windowListeners.size).toBe(0);
  expect(env.documentListeners.size).toBe(0);
});

test("public shape selector supports reduced motion and animated forward/reverse morphs", async () => {
  const reduced = setup({ reducedMotion: true });
  const reducedRenderer = createRenderer({ canvas: reduced.canvas });
  await reducedRenderer.ready;
  reducedRenderer.setSphereMix(1);
  reduced.fireFrame(1);
  expect(mocks.setSettings.mock.calls.at(-1)?.[3].glass.sphereMix).toBe(1);
  reducedRenderer.dispose();

  guiState.instances.length = 0;
  guiState.properties.length = 0;
  vi.resetAllMocks();
  vi.unstubAllGlobals();
  const animated = setup();
  const renderer = createRenderer({ canvas: animated.canvas });
  await renderer.ready;
  renderer.setSphereMix(1);
  animated.fireFrame(1040);
  expect(mocks.setSettings.mock.calls.at(-1)?.[3]).toMatchObject({
    glass: { sphereMix: 1 },
    morphDirection: 1,
  });

  renderer.setSphereMix(0);
  animated.fireFrame(1560);
  expect(mocks.setSettings.mock.calls.at(-1)?.[3]).toMatchObject({
    glass: { sphereMix: 0.0625 },
    morphDirection: -1,
  });
  renderer.dispose();
});

test("coalesces resize and applies mouse orbit input", async () => {
  const env = setup();
  const renderer = createRenderer({ canvas: env.canvas });
  await renderer.ready;

  env.windowListeners.get("pointermove")?.({
    clientX: 400,
    clientY: 0,
    pointerType: "mouse",
  } as unknown as Event);
  env.fireFrame(16);
  expect(mocks.setSettings.mock.calls.at(-1)?.[3].view.pointer).toEqual([
    0.02, -0.02,
  ]);

  env.setRect(320, 180);
  env.fireResize();
  env.fireResize();
  expect(env.frames.size).toBeGreaterThan(0);
  env.fireFrame(32);
  if (env.canvasSurface.resize.mock.calls.length === 1) env.fireFrame(33);
  expect(env.canvasSurface.resize).toHaveBeenCalledWith([640, 360]);
  expect(mocks.resizeScene).toHaveBeenCalledWith(env.scene, [640, 360]);
  renderer.dispose();
});

test("visibility pauses and resumes the animated orb", async () => {
  const env = setup({ reducedMotion: true });
  const renderer = createRenderer({ canvas: env.canvas });
  await renderer.ready;
  renderer.setSphereMix(1);
  expect(env.frames.size).toBe(2);
  env.fireIntersection(false);
  expect(env.frames.size).toBe(1);
  env.fireFrame(1);
  expect(env.frames.size).toBe(0);
  env.fireIntersection(true);
  expect(env.frames.size).toBe(1);
  env.page.hidden = true;
  env.documentListeners.get("visibilitychange")?.({} as Event);
  expect(env.frames.size).toBe(0);
  renderer.dispose();
});

test("disposal before GPU initialization releases the stale GPU", async () => {
  const env = setup();
  const pending = deferred<typeof env.gpu>();
  mocks.init.mockReturnValue(pending.promise);
  const renderer = createRenderer({ canvas: env.canvas });
  await vi.waitFor(() => expect(mocks.init).toHaveBeenCalled());
  renderer.dispose();
  pending.resolve(env.gpu);
  await renderer.ready;
  expect(env.gpu.dispose).toHaveBeenCalledTimes(1);
  expect(mocks.loadAssets).not.toHaveBeenCalled();
});

test("disposal aborts stale asset loading without child-by-child teardown", async () => {
  const env = setup();
  const pending = deferred<typeof env.assets>();
  mocks.loadAssets.mockReturnValue(pending.promise);
  const renderer = createRenderer({ canvas: env.canvas });
  await vi.waitFor(() => expect(mocks.loadAssets).toHaveBeenCalled());
  const signal = mocks.loadAssets.mock.calls[0]?.[1] as AbortSignal;
  renderer.dispose();
  expect(signal.aborted).toBe(true);
  pending.resolve(env.assets);
  await renderer.ready;
  expect(env.gpu.dispose).toHaveBeenCalledTimes(1);
  expect(env.assets.dispose).not.toHaveBeenCalled();
  expect(mocks.createScene).not.toHaveBeenCalled();
});

test("initialization and live render failures preserve primary error identity", async () => {
  const initEnv = setup();
  const initFailure = new Error("compile failed");
  mocks.createScene.mockRejectedValue(initFailure);
  const failedRenderer = createRenderer({ canvas: initEnv.canvas });
  await expect(failedRenderer.ready).rejects.toBe(initFailure);
  await vi.dynamicImportSettled();
  expect(initEnv.gpu.dispose).toHaveBeenCalledTimes(1);

  vi.resetAllMocks();
  vi.unstubAllGlobals();
  const firstDrawEnv = setup();
  const firstDrawFailure = new Error("initial uniform write failed");
  mocks.setSettings.mockImplementation(() => {
    throw firstDrawFailure;
  });
  const firstDrawRenderer = createRenderer({ canvas: firstDrawEnv.canvas });
  await expect(firstDrawRenderer.ready).rejects.toBe(firstDrawFailure);
  await vi.dynamicImportSettled();
  expect(firstDrawEnv.gpu.dispose).toHaveBeenCalledTimes(1);

  vi.resetAllMocks();
  vi.unstubAllGlobals();
  const liveEnv = setup();
  const renderer = createRenderer({ canvas: liveEnv.canvas });
  await renderer.ready;
  const liveFailure = new Error("uniform write failed");
  mocks.setSettings.mockImplementation(() => {
    throw liveFailure;
  });
  liveEnv.windowListeners.get("pointermove")?.({
    clientX: 400,
    clientY: 100,
    pointerType: "mouse",
  } as unknown as Event);
  expect(() => liveEnv.fireFrame(16)).toThrow(liveFailure);
  expect(liveEnv.gpu.dispose).toHaveBeenCalledTimes(1);
});
