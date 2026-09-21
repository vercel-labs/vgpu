import { afterEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cameras: [] as Array<{
    set: ReturnType<typeof vi.fn>;
    viewProjection: Float32Array;
    worldPosition: Float32Array;
  }>,
  controls: [] as Array<{
    dispose: ReturnType<typeof vi.fn>;
    set: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    yaw: number;
  }>,
  guiAddError: undefined as unknown,
  guis: [] as Array<{
    destroy: ReturnType<typeof vi.fn>;
    domElement: { style: Record<string, string> };
    folders: Array<{
      controls: Array<{
        change?: () => void;
        key: string;
        label?: string;
        max?: number;
        min?: number;
        object: Record<string, unknown>;
        setValue(value: unknown): void;
        step?: number;
      }>;
      name: string;
    }>;
  }>,
  init: vi.fn(),
}));

vi.mock("lil-gui", () => ({
  default: class FakeGui {
    destroy = vi.fn();
    domElement = { style: {} as Record<string, string> };
    folders: (typeof mocks.guis)[number]["folders"] = [];

    constructor() {
      mocks.guis.push(this);
    }

    addFolder(name: string) {
      const folder = {
        name,
        controls: [] as (typeof this.folders)[number]["controls"],
        add: (
          object: Record<string, unknown>,
          key: string,
          min?: number,
          max?: number,
          step?: number
        ) => {
          if (mocks.guiAddError !== undefined) throw mocks.guiAddError;
          const control = {
            object,
            key,
            min,
            max,
            step,
            label: undefined as string | undefined,
            change: undefined as (() => void) | undefined,
            name(label: string) {
              control.label = label;
              return control;
            },
            onChange(change: () => void) {
              control.change = change;
              return control;
            },
            setValue(value: unknown) {
              object[key] = value;
              control.change?.();
            },
          };
          folder.controls.push(control);
          return control;
        },
      };
      this.folders.push(folder);
      return folder;
    }
  },
}));

const routed = vi.hoisted(() =>
  Object.fromEntries(
    [
      "compute",
      "draw",
      "effect",
      "frame",
      "frameLoop",
      "geometry",
      "sampler",
      "storage",
      "surface",
      "target",
    ].map((name) => [
      name,
      (
        gpu: { fns: Record<string, (...args: unknown[]) => unknown> },
        ...args: unknown[]
      ) => gpu.fns[name]!(...args),
    ])
  )
);

vi.mock("vgpu", () => ({
  ...routed,
  clock: (gpu: { clock: unknown }) => gpu.clock,
  init: mocks.init,
}));

vi.mock("vgpu/scene", () => ({
  sphere: (options: unknown) => ({ options }),
  perspectiveCamera: vi.fn(() => {
    const camera = {
      set: vi.fn(),
      viewProjection: new Float32Array(16),
      worldPosition: new Float32Array([0, 24, 128]),
    };
    mocks.cameras.push(camera);
    return camera;
  }),
  orbitControls: vi.fn(() => {
    const controls = {
      dispose: vi.fn(),
      set: vi.fn((update: { yaw?: number }) => {
        if (update.yaw !== undefined) controls.yaw = update.yaw;
      }),
      update: vi.fn(),
      yaw: 0.25,
    };
    mocks.controls.push(controls);
    return controls;
  }),
}));

import GUI from "lil-gui";

import { renderThumbnail } from "./render-thumbnail";
import { configureGui, createRenderer } from "./renderer";
import { buildOcean, DEFAULT_PARAMS } from "./scene";

interface FakeResource {
  destroy: ReturnType<typeof vi.fn>;
  destroyError?: unknown;
  kind: string;
  resourceIndex: number;
}

interface FakeDrawable {
  dispatch: ReturnType<typeof vi.fn>;
  draw: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  setError?: unknown;
  sets: unknown[];
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, reject, resolve };
}

function setupGpu() {
  const computes: FakeDrawable[] = [];
  const draws: FakeDrawable[] = [];
  const effects: FakeDrawable[] = [];
  const passes: Array<{ drawable?: FakeDrawable; target: unknown }> = [];
  const resources: FakeResource[] = [];
  const storages: FakeResource[] = [];
  const targets: Array<
    FakeResource & {
      format: GPUTextureFormat;
      size: [number, number];
    }
  > = [];
  const fail = {
    computeAt: 0,
    destroyAt: -1,
    error: undefined as unknown,
    frame: undefined as unknown,
    geometryAt: 0,
    storageAt: 0,
    targetAt: 0,
  };
  const calls = { compute: 0, geometry: 0, storage: 0, target: 0 };
  let loop: ((frame: ReturnType<typeof makeFrame>) => void) | undefined;
  let resize: (() => void) | undefined;

  const makeResource = (kind: string): FakeResource => {
    const resource = {
      kind,
      resourceIndex: resources.length,
      destroyError: undefined as unknown,
      destroy: vi.fn(() => {
        if (
          resource.destroyError !== undefined ||
          fail.destroyAt === resource.resourceIndex
        ) {
          throw resource.destroyError ?? fail.error;
        }
      }),
    };
    resources.push(resource);
    return resource;
  };
  const makeDrawable = (): FakeDrawable => {
    const drawable = {
      dispatch: vi.fn(),
      draw: vi.fn(),
      sets: [] as unknown[],
      setError: undefined as unknown,
      set: vi.fn((value: unknown) => {
        if (drawable.setError !== undefined) throw drawable.setError;
        drawable.sets.push(value);
        return drawable;
      }),
    };
    return drawable;
  };
  const makeFrame = () => ({
    pass: vi.fn((targetOrOptions: unknown, renderOrDrawable: unknown) => {
      const descriptor = targetOrOptions as { target?: unknown };
      const pass = { target: descriptor.target ?? targetOrOptions };
      if (typeof renderOrDrawable === "function") {
        (
          renderOrDrawable as (encoder: {
            draw(value: FakeDrawable): void;
          }) => void
        )({
          draw(value) {
            passes.push({ ...pass, drawable: value });
          },
        });
      } else {
        passes.push({ ...pass, drawable: renderOrDrawable as FakeDrawable });
      }
    }),
  });

  const output = {
    format: "rgba8unorm" as GPUTextureFormat,
    onResize: vi.fn((callback: () => void) => {
      resize = callback;
      callback();
      return unsubscribeResize;
    }),
    size: [800, 450] as [number, number],
  };
  const unsubscribeResize = vi.fn();
  const queue = { onSubmittedWorkDone: vi.fn(async () => {}) };
  const gpu = {
    clock: { deltaTime: 1 / 60 },
    dispose: vi.fn(),
    fns: {
      compute: vi.fn(() => {
        calls.compute++;
        if (fail.computeAt === calls.compute) throw fail.error;
        const value = makeDrawable();
        computes.push(value);
        return value;
      }),
      draw: vi.fn(() => {
        const value = makeDrawable();
        draws.push(value);
        return value;
      }),
      effect: vi.fn(() => {
        const value = makeDrawable();
        effects.push(value);
        return value;
      }),
      frame: vi.fn((render: (value: ReturnType<typeof makeFrame>) => void) => {
        if (fail.frame !== undefined) throw fail.frame;
        render(makeFrame());
      }),
      frameLoop: vi.fn(
        (render: (value: ReturnType<typeof makeFrame>) => void) => {
          loop = render;
          return loopHandle;
        }
      ),
      geometry: vi.fn(() => {
        calls.geometry++;
        if (fail.geometryAt === calls.geometry) throw fail.error;
        return makeResource("geometry");
      }),
      sampler: vi.fn(() => ({})),
      storage: vi.fn(() => {
        calls.storage++;
        if (fail.storageAt === calls.storage) throw fail.error;
        const value = makeResource("storage");
        storages.push(value);
        return value;
      }),
      surface: vi.fn(() => output),
      target: vi.fn(
        (options: { format?: GPUTextureFormat; size: [number, number] }) => {
          calls.target++;
          if (fail.targetAt === calls.target) throw fail.error;
          const value = Object.assign(makeResource("target"), {
            format: options.format ?? ("rgba8unorm" as GPUTextureFormat),
            size: [...options.size] as [number, number],
          });
          targets.push(value);
          return value;
        }
      ),
    },
    gpu: { queue },
    settled: vi.fn(async () => {}),
  };
  const loopHandle = { stop: vi.fn() };

  return {
    calls,
    computes,
    draws,
    effects,
    fail,
    fireLoop() {
      if (!loop) throw new Error("No frame loop registered");
      loop(makeFrame());
    },
    fireResize(size: [number, number]) {
      output.size = size;
      if (!resize) throw new Error("No resize listener registered");
      resize();
    },
    gpu,
    loopHandle,
    output,
    passes,
    queue,
    resources,
    storages,
    targets,
    unsubscribeResize,
  };
}

function control(folder: string, key: string) {
  const gui = mocks.guis.at(-1)!;
  return gui.folders
    .find(({ name }) => name === folder)!
    .controls.find((candidate) => candidate.key === key)!;
}

afterEach(() => {
  mocks.cameras.length = 0;
  mocks.controls.length = 0;
  mocks.guis.length = 0;
  mocks.guiAddError = undefined;
  mocks.init.mockReset();
  vi.clearAllMocks();
});

test("binds every lil-gui control to its real object and rebuild callbacks", () => {
  const params = { ...DEFAULT_PARAMS };
  const rebuild = vi.fn();
  const view = { autoRotate: false, rotateSpeed: 0.12 };
  const gui = new GUI();
  configureGui(gui, { params } as never, view, rebuild);

  const instance = mocks.guis.at(-1)!;
  expect(instance.folders.map(({ name }) => name)).toEqual([
    "Waves",
    "Look",
    "Sun",
    "Sim",
  ]);
  expect(
    instance.folders.flatMap(({ controls }) =>
      controls.map(({ key, label, min, max, step }) => [
        key,
        label,
        min,
        max,
        step,
      ])
    )
  ).toEqual([
    ["windSpeed", "wind speed", 2, 60, 0.5],
    ["windAngle", "wind angle", 0, 360, 1],
    ["amplitude", undefined, 0.2, 16, 0.1],
    ["patchSize", "patch size (m)", 60, 600, 1],
    ["heightScale", "height", 0, 80, 0.5],
    ["choppyScale", "choppiness", 0, 40, 0.5],
    ["foamScale", "foam", 0.05, 1.2, 0.01],
    ["sunElevation", "elevation", -2, 60, 0.5],
    ["sunAzimuth", "azimuth", 0, 360, 1],
    ["timeScale", "speed", 0, 3, 0.05],
    ["autoRotate", "auto-rotate", undefined, undefined, undefined],
    ["rotateSpeed", "rotate speed", 0.02, 0.6, 0.01],
  ]);

  for (const [key, value] of [
    ["windSpeed", 40],
    ["windAngle", 210],
    ["amplitude", 7],
    ["patchSize", 400],
  ] as const) {
    control("Waves", key).setValue(value);
    expect(params[key]).toBe(value);
  }
  control("Look", "foamScale").setValue(0.8);
  control("Sun", "sunElevation").setValue(20);
  control("Sim", "timeScale").setValue(1.5);
  control("Sim", "autoRotate").setValue(true);
  control("Sim", "rotateSpeed").setValue(0.4);
  expect(rebuild).toHaveBeenCalledTimes(4);
  expect(params).toMatchObject({
    foamScale: 0.8,
    sunElevation: 20,
    timeScale: 1.5,
  });
  expect(view).toEqual({ autoRotate: true, rotateSpeed: 0.4 });
  expect(instance.domElement.style).toMatchObject({
    position: "absolute",
    right: "8px",
    top: "8px",
  });
});

test("propagates orbit and auto-rotate state through the live frame", async () => {
  const env = setupGpu();
  mocks.init.mockResolvedValueOnce(env.gpu);
  const renderer = createRenderer({ canvas: { parentElement: {} } as never });
  await renderer.ready;

  control("Sim", "autoRotate").setValue(true);
  control("Sim", "rotateSpeed").setValue(0.6);
  env.gpu.clock.deltaTime = 0.5;
  env.fireLoop();

  const orbit = mocks.controls[0]!;
  expect(orbit.update).toHaveBeenCalledWith(0.5);
  expect(orbit.set).toHaveBeenCalledWith({ yaw: 0.55 });
  expect(
    env.computes.slice(1, 4).map(({ dispatch }) => dispatch.mock.calls[0])
  ).toEqual([
    [32, 32],
    [256, 1],
    [256, 1],
  ]);
  expect(env.passes).toHaveLength(3);
  renderer.dispose();
});

test("direct dispose is idempotent, attempts every browser cleanup, and reports the first error", async () => {
  const env = setupGpu();
  mocks.init.mockResolvedValueOnce(env.gpu);
  const renderer = createRenderer({ canvas: { parentElement: {} } as never });
  await renderer.ready;
  const first = new Error("loop cleanup");
  env.loopHandle.stop.mockImplementationOnce(() => {
    throw first;
  });
  env.unsubscribeResize.mockImplementationOnce(() => {
    throw new Error("resize cleanup");
  });

  expect(() => renderer.dispose()).toThrow(first);
  expect(env.loopHandle.stop).toHaveBeenCalledTimes(1);
  expect(env.unsubscribeResize).toHaveBeenCalledTimes(1);
  expect(mocks.controls[0]!.dispose).toHaveBeenCalledTimes(1);
  expect(mocks.guis[0]!.destroy).toHaveBeenCalledTimes(1);
  expect(env.gpu.dispose).toHaveBeenCalledTimes(1);
  expect(() => renderer.dispose()).not.toThrow();
  expect(env.gpu.dispose).toHaveBeenCalledTimes(1);
});

test("disposes a late GPU and keeps intentional stale rejection quiet", async () => {
  const env = setupGpu();
  const init = deferred<typeof env.gpu>();
  mocks.init.mockReturnValueOnce(init.promise);
  const renderer = createRenderer({ canvas: {} as never });
  await vi.waitFor(() => expect(mocks.init).toHaveBeenCalledTimes(1));
  renderer.dispose();
  init.resolve(env.gpu);
  await renderer.ready;
  expect(env.gpu.dispose).toHaveBeenCalledTimes(1);
  expect(env.gpu.fns.surface).not.toHaveBeenCalled();

  const rejected = deferred<never>();
  mocks.init.mockReturnValueOnce(rejected.promise);
  const stale = createRenderer({ canvas: {} as never });
  await vi.waitFor(() => expect(mocks.init).toHaveBeenCalledTimes(2));
  stale.dispose();
  rejected.reject(new Error("late init"));
  await expect(stale.ready).resolves.toBeUndefined();
});

test("partial GUI construction rolls back browser state and preserves the primary error", async () => {
  const env = setupGpu();
  const primary = new Error("gui add");
  mocks.guiAddError = primary;
  mocks.init.mockResolvedValueOnce(env.gpu);
  const renderer = createRenderer({ canvas: { parentElement: {} } as never });

  await expect(renderer.ready).rejects.toBe(primary);
  expect(mocks.controls[0]!.dispose).toHaveBeenCalledTimes(1);
  expect(mocks.guis[0]!.destroy).toHaveBeenCalledTimes(1);
  expect(env.gpu.dispose).toHaveBeenCalledTimes(1);
  expect(env.gpu.fns.frameLoop).not.toHaveBeenCalled();
});

test("frame, resize, and spectrum rebuild failures tear down and rethrow exactly", async () => {
  const frameEnv = setupGpu();
  mocks.init.mockResolvedValueOnce(frameEnv.gpu);
  const frameRenderer = createRenderer({
    canvas: { parentElement: {} } as never,
  });
  await frameRenderer.ready;
  const frameError = new Error("simulate");
  frameEnv.computes[1]!.setError = frameError;
  expect(() => frameEnv.fireLoop()).toThrow(frameError);
  expect(frameEnv.gpu.dispose).toHaveBeenCalledTimes(1);

  const resizeEnv = setupGpu();
  mocks.init.mockResolvedValueOnce(resizeEnv.gpu);
  const resizeRenderer = createRenderer({
    canvas: { parentElement: {} } as never,
  });
  await resizeRenderer.ready;
  const resizeError = new Error("resize target");
  resizeEnv.fail.error = resizeError;
  resizeEnv.fail.targetAt = resizeEnv.calls.target + 1;
  expect(() => resizeEnv.fireResize([640, 360])).toThrow(resizeError);
  expect(resizeEnv.gpu.dispose).toHaveBeenCalledTimes(1);

  const rebuildEnv = setupGpu();
  mocks.init.mockResolvedValueOnce(rebuildEnv.gpu);
  const rebuildRenderer = createRenderer({
    canvas: { parentElement: {} } as never,
  });
  await rebuildRenderer.ready;
  const rebuildError = new Error("spectrum pass");
  rebuildEnv.fail.error = rebuildError;
  rebuildEnv.fail.computeAt = rebuildEnv.calls.compute + 1;
  expect(() => control("Waves", "windSpeed").setValue(30)).toThrow(
    rebuildError
  );
  expect(rebuildEnv.storages.at(-1)!.destroy).toHaveBeenCalledTimes(1);
  expect(rebuildEnv.gpu.dispose).toHaveBeenCalledTimes(1);
});

test("build allocation failure destroys every captured resource without masking primary", () => {
  const env = setupGpu();
  const primary = new Error("second target");
  env.fail.error = primary;
  env.fail.targetAt = 2;
  env.fail.destroyAt = 2;

  expect(() => buildOcean(env.gpu as never, [320, 180])).toThrow(primary);
  expect(env.resources).toHaveLength(10);
  expect(
    env.resources.every(({ destroy }) => destroy.mock.calls.length === 1)
  ).toBe(true);
});

test("spectrum and resize replacements commit only after candidates succeed", () => {
  const env = setupGpu();
  const scene = buildOcean(env.gpu as never, [320, 180]);
  const initialH0 = env.storages[0]!;
  const initialHdr = scene.hdr;

  scene.rebuildSpectrum();
  const replacementH0 = env.storages.at(-1)!;
  expect(initialH0.destroy).toHaveBeenCalledTimes(1);
  expect(env.computes[1]!.sets.at(-1)).toEqual({ h0: replacementH0 });

  const rebuildError = new Error("bind replacement");
  env.computes[1]!.setError = rebuildError;
  expect(() => scene.rebuildSpectrum()).toThrow(rebuildError);
  expect(env.storages.at(-1)!.destroy).toHaveBeenCalledTimes(1);
  expect(replacementH0.destroy).not.toHaveBeenCalled();
  env.computes[1]!.setError = undefined;

  scene.resize([640, 360]);
  const replacementHdr = scene.hdr;
  expect(replacementHdr).not.toBe(initialHdr);
  expect((initialHdr as unknown as FakeResource).destroy).toHaveBeenCalledTimes(
    1
  );

  const resizeError = new Error("bind target");
  env.effects[1]!.setError = resizeError;
  expect(() => scene.resize([900, 500])).toThrow(resizeError);
  expect(scene.hdr).toBe(replacementHdr);
  expect(env.targets.at(-1)!.destroy).toHaveBeenCalledTimes(1);
});

test("scene destroy is idempotent, best-effort, and returns its first cleanup error", () => {
  const env = setupGpu();
  const scene = buildOcean(env.gpu as never, [320, 180]);
  const first = new Error("first resource");
  env.resources[6]!.destroyError = first;
  env.resources[2]!.destroyError = new Error("later resource");

  expect(() => scene.destroy()).toThrow(first);
  expect(
    env.resources.every(({ destroy }) => destroy.mock.calls.length === 1)
  ).toBe(true);
  expect(() => scene.destroy()).not.toThrow();
  expect(
    env.resources.every(({ destroy }) => destroy.mock.calls.length === 1)
  ).toBe(true);
});

test("thumbnail preserves warmup time and waits for both shared-GPU barriers before cleanup", async () => {
  const env = setupGpu();
  const queue = deferred();
  const settled = deferred();
  env.queue.onSubmittedWorkDone.mockReturnValueOnce(queue.promise);
  env.gpu.settled.mockReturnValueOnce(settled.promise);

  const rendering = renderThumbnail(env.gpu as never, env.output as never, {
    dt: 0.25,
    warmupFrames: 2,
    time: 2,
  });
  await Promise.resolve();
  await Promise.resolve();
  expect(env.queue.onSubmittedWorkDone).toHaveBeenCalledTimes(1);
  expect(env.gpu.settled).toHaveBeenCalledTimes(1);
  expect(env.resources.some(({ destroy }) => destroy.mock.calls.length)).toBe(
    false
  );

  settled.resolve();
  await Promise.resolve();
  expect(env.resources.some(({ destroy }) => destroy.mock.calls.length)).toBe(
    false
  );
  queue.resolve();
  await rendering;
  expect(
    env.computes[1]!.sets.map(
      (value) => (value as { sim: { time: number } }).sim.time
    )
  ).toEqual([0.25, 0.5, 2]);
  expect(
    env.resources.every(({ destroy }) => destroy.mock.calls.length === 1)
  ).toBe(true);
  expect(env.gpu.dispose).not.toHaveBeenCalled();
});

test("thumbnail also waits when the queue barrier settles first", async () => {
  const env = setupGpu();
  const queue = deferred();
  const settled = deferred();
  env.queue.onSubmittedWorkDone.mockReturnValueOnce(queue.promise);
  env.gpu.settled.mockReturnValueOnce(settled.promise);

  const rendering = renderThumbnail(env.gpu as never, env.output as never);
  await Promise.resolve();
  queue.resolve();
  await Promise.resolve();
  expect(env.resources.some(({ destroy }) => destroy.mock.calls.length)).toBe(
    false
  );
  settled.resolve();
  await rendering;
  expect(
    env.resources.every(({ destroy }) => destroy.mock.calls.length === 1)
  ).toBe(true);
});

test("thumbnail calls both barriers on sync/rejection failure and keeps the first barrier error", async () => {
  const env = setupGpu();
  const queueError = new Error("queue sync");
  const settledError = new Error("settled async");
  env.queue.onSubmittedWorkDone.mockImplementationOnce(() => {
    throw queueError;
  });
  env.gpu.settled.mockRejectedValueOnce(settledError);

  await expect(
    renderThumbnail(env.gpu as never, env.output as never)
  ).rejects.toBe(queueError);
  expect(env.queue.onSubmittedWorkDone).toHaveBeenCalledTimes(1);
  expect(env.gpu.settled).toHaveBeenCalledTimes(1);
  expect(
    env.resources.every(({ destroy }) => destroy.mock.calls.length === 1)
  ).toBe(true);
  expect(env.gpu.dispose).not.toHaveBeenCalled();
});

test("thumbnail preserves a primary render or partial-construction error through all cleanup", async () => {
  const renderEnv = setupGpu();
  const primary = new Error("frame");
  renderEnv.fail.frame = primary;
  renderEnv.queue.onSubmittedWorkDone.mockRejectedValueOnce(new Error("queue"));
  renderEnv.gpu.settled.mockRejectedValueOnce(new Error("settled"));
  renderEnv.fail.error = new Error("destroy");
  renderEnv.fail.destroyAt = 3;
  await expect(
    renderThumbnail(renderEnv.gpu as never, renderEnv.output as never)
  ).rejects.toBe(primary);
  expect(
    renderEnv.resources.every(({ destroy }) => destroy.mock.calls.length === 1)
  ).toBe(true);

  const partialEnv = setupGpu();
  const partial = new Error("partial target");
  partialEnv.fail.error = partial;
  partialEnv.fail.targetAt = 2;
  await expect(
    renderThumbnail(partialEnv.gpu as never, partialEnv.output as never)
  ).rejects.toBe(partial);
  expect(partialEnv.queue.onSubmittedWorkDone).toHaveBeenCalledTimes(1);
  expect(partialEnv.gpu.settled).toHaveBeenCalledTimes(1);
  expect(
    partialEnv.resources.every(({ destroy }) => destroy.mock.calls.length === 1)
  ).toBe(true);
  expect(partialEnv.gpu.dispose).not.toHaveBeenCalled();
});
