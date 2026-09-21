import { afterEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({ init: vi.fn() }));
const routedFunctions = vi.hoisted(() =>
  Object.fromEntries(
    [
      "surface",
      "target",
      "effect",
      "draw",
      "sampler",
      "frame",
      "frameLoop",
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
  init: mocks.init,
  ...routedFunctions,
  clock: (gpu: { clock: unknown }) => gpu.clock,
}));

import { renderThumbnail } from "./render-thumbnail";
import {
  bloomSizes,
  createGraph,
  createRenderer,
  renderGraph,
} from "./renderer";

interface FakeTarget {
  color: { destroy: ReturnType<typeof vi.fn>; read: ReturnType<typeof vi.fn> };
  format: GPUTextureFormat;
  label: string;
  size: [number, number];
  texelSize: [number, number];
}

interface FakeDrawable {
  compile: ReturnType<typeof vi.fn>;
  label: string;
  set: ReturnType<typeof vi.fn>;
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

function setupGpu(
  options: {
    compile?: (label: string) => Promise<unknown>;
    effect?: (label: string) => void;
    size?: [number, number];
  } = {}
) {
  const targets: FakeTarget[] = [];
  const effects: FakeDrawable[] = [];
  const draws: FakeDrawable[] = [];
  const passes: Array<{
    clear: readonly number[];
    drawable: string;
    target: string;
  }> = [];
  let loop: ((frame: unknown) => void) | undefined;
  let resize: (() => void) | undefined;
  const unsubscribe = vi.fn();
  const pixels = new Uint8Array([1, 2, 3, 4]);
  const output = {
    format: "rgba8unorm" as GPUTextureFormat,
    label: "output",
    onResize: vi.fn((callback: () => void) => {
      resize = callback;
      return unsubscribe;
    }),
    color: { read: vi.fn(async () => pixels) },
    size: options.size ?? ([320, 180] as [number, number]),
  };

  const makeDrawable = (label: string): FakeDrawable => {
    const drawable = {} as FakeDrawable;
    drawable.label = label;
    drawable.set = vi.fn(() => drawable);
    drawable.compile = vi.fn(
      () => options.compile?.(label) ?? Promise.resolve()
    );
    return drawable;
  };
  const makeFrame = () => ({
    pass: vi.fn(
      (
        descriptor: { clear: readonly number[]; target: { label: string } },
        encode: (encoder: { draw(drawable: FakeDrawable): void }) => void
      ) => {
        encode({
          draw(drawable) {
            passes.push({
              clear: descriptor.clear,
              drawable: drawable.label,
              target: descriptor.target.label,
            });
          },
        });
      }
    ),
  });
  const queue = { onSubmittedWorkDone: vi.fn(async () => {}) };
  const gpu = {
    clock: { time: 0, deltaTime: 0, frameCount: 0, advance: vi.fn() },
    dispose: vi.fn(),
    fns: {
      draw: vi.fn((_descriptor: unknown) => {
        const value = makeDrawable("particles");
        draws.push(value);
        return value;
      }),
      effect: vi.fn((_shader: unknown, descriptor: { label: string }) => {
        options.effect?.(descriptor.label);
        const value = makeDrawable(descriptor.label);
        effects.push(value);
        return value;
      }),
      frame: vi.fn((render: (value: unknown) => void) => render(makeFrame())),
      frameLoop: vi.fn((render: (value: unknown) => void) => {
        loop = render;
      }),
      sampler: vi.fn(() => ({ label: "linear-sampler" })),
      surface: vi.fn(() => output),
      target: vi.fn(
        (descriptor: {
          format: GPUTextureFormat;
          label: string;
          size: readonly [number, number];
        }) => {
          const size: [number, number] = [
            descriptor.size[0],
            descriptor.size[1],
          ];
          const value: FakeTarget = {
            color: { destroy: vi.fn(), read: vi.fn(async () => pixels) },
            format: descriptor.format,
            label: descriptor.label,
            size,
            texelSize: [1 / size[0], 1 / size[1]],
          };
          targets.push(value);
          return value;
        }
      ),
    },
    gpu: { queue },
    settled: vi.fn(async () => {}),
  };

  return {
    draws,
    effects,
    fireLoop() {
      if (!loop) throw new Error("No frame loop is registered.");
      loop(makeFrame());
    },
    fireResize() {
      if (!resize) throw new Error("No resize listener is registered.");
      resize();
    },
    gpu,
    output,
    passes,
    pixels,
    queue,
    targets,
    unsubscribe,
  };
}

function setupBrowser() {
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
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
  return {
    fireNext() {
      const entry = frames.entries().next().value as
        | [number, FrameRequestCallback]
        | undefined;
      if (!entry) throw new Error("No animation frame is pending.");
      frames.delete(entry[0]);
      return entry[1](16) as unknown as Promise<void> | undefined;
    },
    frames,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

test("builds the fixed-size graph and renders the exact FFT/bloom pass order", async () => {
  const env = setupGpu({ size: [801, 451] });
  const graph = await createGraph(
    env.gpu as never,
    env.output as never,
    "test"
  );

  expect(bloomSizes(env.output.size)).toEqual([
    [401, 226],
    [201, 113],
    [101, 57],
    [51, 29],
    [26, 15],
  ]);
  expect(env.targets).toHaveLength(19);
  expect(
    env.targets.slice(0, 6).map(({ format, size }) => [format, size])
  ).toEqual(Array(6).fill(["rgba32float", [512, 512]]));
  expect(graph.scene.size).toEqual([801, 451]);
  expect(graph.bloom.levels.map((level) => level.vertical.size)).toEqual(
    bloomSizes(env.output.size)
  );

  renderGraph(
    {
      pass(
        descriptor: { clear: readonly number[]; target: { label: string } },
        encode: (encoder: { draw(drawable: FakeDrawable): void }) => void
      ) {
        encode({
          draw(drawable) {
            env.passes.push({
              clear: descriptor.clear,
              drawable: drawable.label,
              target: descriptor.target.label,
            });
          },
        });
      },
    } as never,
    graph,
    env.output as never
  );

  expect(env.passes.map(({ target }) => target)).toEqual([
    "test-noise",
    "test-h0",
    "test-spectrum",
    ...Array.from(
      { length: 18 },
      (_, index) => `test-${index % 2 ? "pong" : "ping"}`
    ),
    "test-normal-foam",
    "test-scene",
    "test-bright",
    ...Array.from({ length: 5 }, (_, index) => [
      `test-bloom-h${index}`,
      `test-bloom-v${index}`,
    ]).flat(),
    "test-composite",
    "output",
  ]);
  expect(env.passes.every(({ clear }) => clear.join() === "0,0,0,0")).toBe(
    true
  );

  const secondPass = vi.fn();
  renderGraph({ pass: secondPass } as never, graph, env.output as never);
  expect(secondPass).toHaveBeenCalledTimes(34);
  expect(graph.needsInitialSpectrum).toBe(false);
});

test("coalesces live resize, swaps transactionally, and delegates owned teardown", async () => {
  const browser = setupBrowser();
  const env = setupGpu();
  mocks.init.mockResolvedValueOnce(env.gpu);
  const renderer = createRenderer({ canvas: {} as HTMLCanvasElement });
  await renderer.ready;
  const initialTargets = env.targets.slice();

  env.output.size = [640, 360];
  env.fireResize();
  env.fireResize();
  expect(browser.frames.size).toBe(1);
  browser.fireNext();
  await vi.waitFor(() =>
    expect(
      initialTargets.every(
        (value) => value.color.destroy.mock.calls.length === 1
      )
    ).toBe(true)
  );
  expect(env.targets).toHaveLength(38);
  expect(
    env.targets
      .slice(19)
      .every((value) => !value.color.destroy.mock.calls.length)
  ).toBe(true);

  env.output.size = [700, 400];
  env.fireResize();
  expect(browser.frames.size).toBe(1);
  renderer.dispose();
  renderer.dispose();
  expect(browser.frames.size).toBe(0);
  expect(env.unsubscribe).toHaveBeenCalledOnce();
  expect(env.gpu.dispose).toHaveBeenCalledOnce();
  expect(
    env.targets
      .slice(19)
      .every((value) => !value.color.destroy.mock.calls.length)
  ).toBe(true);
});

test("rolls back a stale resize without replacing the newer graph", async () => {
  const browser = setupBrowser();
  const stale = deferred();
  const env = setupGpu({
    compile: (label) =>
      label === "fft-ocean-resize-1-noise" ? stale.promise : Promise.resolve(),
  });
  mocks.init.mockResolvedValueOnce(env.gpu);
  const renderer = createRenderer({ canvas: {} as HTMLCanvasElement });
  await renderer.ready;

  env.output.size = [400, 225];
  env.fireResize();
  browser.fireNext();
  await vi.waitFor(() => expect(env.targets).toHaveLength(38));
  env.output.size = [600, 338];
  env.fireResize();
  browser.fireNext();
  await vi.waitFor(() =>
    expect(
      env.targets
        .slice(0, 19)
        .every((target) => target.color.destroy.mock.calls.length)
    ).toBe(true)
  );

  stale.resolve();
  await vi.waitFor(() =>
    expect(
      env.targets
        .slice(19, 38)
        .every((target) => target.color.destroy.mock.calls.length)
    ).toBe(true)
  );
  expect(
    env.targets
      .slice(38)
      .every((target) => !target.color.destroy.mock.calls.length)
  ).toBe(true);
  expect(env.gpu.dispose).not.toHaveBeenCalled();
  renderer.dispose();
});

test("live rebuild failures tear down and remain observable by identity", async () => {
  const browser = setupBrowser();
  const primary = new Error("resize prewarm failed");
  const env = setupGpu({
    compile: (label) =>
      label === "fft-ocean-resize-1-noise"
        ? Promise.reject(primary)
        : Promise.resolve(),
  });
  mocks.init.mockResolvedValueOnce(env.gpu);
  const renderer = createRenderer({ canvas: {} as HTMLCanvasElement });
  await renderer.ready;

  env.output.size = [640, 360];
  env.fireResize();
  await expect(browser.fireNext()).rejects.toBe(primary);
  expect(
    env.targets
      .slice(19)
      .every((target) => target.color.destroy.mock.calls.length)
  ).toBe(true);
  expect(env.unsubscribe).toHaveBeenCalledOnce();
  expect(env.gpu.dispose).toHaveBeenCalledOnce();
  renderer.dispose();
});

test("dispose prevents stale initialization and prewarm work from mounting", async () => {
  setupBrowser();
  const pending = deferred<ReturnType<typeof setupGpu>["gpu"]>();
  mocks.init.mockReturnValueOnce(pending.promise);
  const renderer = createRenderer({ canvas: {} as HTMLCanvasElement });
  await vi.waitFor(() => expect(mocks.init).toHaveBeenCalledOnce());

  renderer.dispose();
  const env = setupGpu();
  pending.resolve(env.gpu);
  await renderer.ready;
  expect(env.gpu.dispose).toHaveBeenCalledOnce();
  expect(env.gpu.fns.surface).not.toHaveBeenCalled();
  expect(env.gpu.fns.frameLoop).not.toHaveBeenCalled();

  const preparation = deferred();
  const preparing = setupGpu({
    compile: (label) =>
      label === "fft-ocean-live-noise"
        ? preparation.promise
        : Promise.resolve(),
  });
  mocks.init.mockResolvedValueOnce(preparing.gpu);
  const preparingRenderer = createRenderer({ canvas: {} as HTMLCanvasElement });
  await vi.waitFor(() => expect(preparing.targets).toHaveLength(19));
  preparingRenderer.dispose();
  preparation.resolve();
  await preparingRenderer.ready;
  expect(preparing.output.onResize).not.toHaveBeenCalled();
  expect(preparing.gpu.fns.frameLoop).not.toHaveBeenCalled();
  expect(preparing.gpu.dispose).toHaveBeenCalledOnce();
});

test("prewarm and live frame failures preserve identity while tearing down", async () => {
  setupBrowser();
  const preparationFailure = new Error("compile failed");
  const preparing = setupGpu({
    compile: (label) =>
      label === "fft-ocean-live-noise"
        ? Promise.reject(preparationFailure)
        : Promise.resolve(),
  });
  mocks.init.mockResolvedValueOnce(preparing.gpu);
  const failedRenderer = createRenderer({ canvas: {} as HTMLCanvasElement });
  await expect(failedRenderer.ready).rejects.toBe(preparationFailure);
  expect(preparing.gpu.dispose).toHaveBeenCalledOnce();

  const rendering = setupGpu();
  mocks.init.mockResolvedValueOnce(rendering.gpu);
  const renderer = createRenderer({ canvas: {} as HTMLCanvasElement });
  await renderer.ready;
  const frameFailure = new Error("render pass failed");
  expect(() =>
    rendering.gpu.fns.frameLoop.mock.calls[0]![0]({
      pass: vi.fn(() => {
        throw frameFailure;
      }),
    })
  ).toThrow(frameFailure);
  expect(rendering.gpu.dispose).toHaveBeenCalledOnce();
  renderer.dispose();
});

test("partial graph allocation attempts every rollback and preserves the primary error", async () => {
  const env = setupGpu();
  const allocationFailure = new Error("target allocation failed");
  const createTarget = env.gpu.fns.target.getMockImplementation()!;
  let allocations = 0;
  env.gpu.fns.target.mockImplementation((descriptor) => {
    if (++allocations === 3) throw allocationFailure;
    const value = createTarget(descriptor);
    if (allocations === 2) {
      value.color.destroy.mockImplementationOnce(() => {
        throw new Error("rollback failed");
      });
    }
    return value;
  });

  const rendering = createGraph(
    env.gpu as never,
    env.output as never,
    "partial"
  );
  await expect(rendering).rejects.toBe(allocationFailure);
  expect(env.targets).toHaveLength(2);
  expect(
    env.targets.every((value) => value.color.destroy.mock.calls.length === 1)
  ).toBe(true);

  const effectFailure = new Error("effect construction failed");
  const effects = setupGpu({
    effect: (label) => {
      if (label === "partial-effect-ifft-4-h") throw effectFailure;
    },
  });
  await expect(
    createGraph(effects.gpu as never, effects.output as never, "partial-effect")
  ).rejects.toBe(effectFailure);
  expect(
    effects.targets.every(
      (value) => value.color.destroy.mock.calls.length === 1
    )
  ).toBe(true);
});

test("thumbnail reports variants, restores the requested time, and retains the shared GPU", async () => {
  const env = setupGpu({ size: [160, 90] });
  const onIntermediateRendered = vi.fn(async () => {});
  const onVariantRendered = vi.fn(async () => {});
  await renderThumbnail(env.gpu as never, env.output as never, {
    onIntermediateRendered,
    onVariantRendered,
    time: 12,
  });

  expect(onIntermediateRendered).toHaveBeenCalledWith(
    "displacement",
    env.pixels,
    [512, 512]
  );
  expect(onVariantRendered).toHaveBeenCalledWith(
    "time-delta",
    env.pixels,
    [160, 90]
  );
  const spectrum = env.effects.find(
    ({ label }) => label === "fft-ocean-thumb-spectrum"
  )!;
  expect(spectrum.set.mock.calls.slice(-3).map(([value]) => value)).toEqual([
    { u: { time: 6 } },
    { u: { time: 8.5 } },
    { u: { time: 6 } },
  ]);
  expect(
    env.targets.every((value) => value.color.destroy.mock.calls.length === 1)
  ).toBe(true);
  expect(env.gpu.dispose).not.toHaveBeenCalled();
});

test("thumbnail waits for both barriers and preserves a render failure through cleanup", async () => {
  const env = setupGpu();
  const primary = new Error("thumbnail render failed");
  const queue = deferred();
  const settled = deferred();
  env.gpu.fns.frame.mockImplementationOnce(() => {
    throw primary;
  });
  env.queue.onSubmittedWorkDone.mockReturnValue(queue.promise);
  env.gpu.settled.mockReturnValue(settled.promise);
  const rendering = renderThumbnail(env.gpu as never, env.output as never);
  env.targets[0]!.color.destroy.mockImplementationOnce(() => {
    throw new Error("cleanup failed");
  });

  await vi.waitFor(() => {
    expect(env.queue.onSubmittedWorkDone).toHaveBeenCalledOnce();
    expect(env.gpu.settled).toHaveBeenCalledOnce();
  });
  queue.resolve();
  await Promise.resolve();
  expect(
    env.targets.every((value) => !value.color.destroy.mock.calls.length)
  ).toBe(true);
  settled.resolve();
  await expect(rendering).rejects.toBe(primary);
  expect(
    env.targets.every((value) => value.color.destroy.mock.calls.length === 1)
  ).toBe(true);
  expect(env.gpu.dispose).not.toHaveBeenCalled();
});

test("thumbnail rolls back a preview target when preview construction fails", async () => {
  const primary = new Error("preview effect failed");
  const env = setupGpu({
    effect: (label) => {
      if (label === "fft-ocean-displacement-preview") throw primary;
    },
  });

  await expect(
    renderThumbnail(env.gpu as never, env.output as never, {
      onIntermediateRendered: vi.fn(),
    })
  ).rejects.toBe(primary);
  expect(env.targets).toHaveLength(20);
  expect(
    env.targets.every((value) => value.color.destroy.mock.calls.length === 1)
  ).toBe(true);
  expect(env.queue.onSubmittedWorkDone).toHaveBeenCalledTimes(3);
  expect(env.gpu.settled).toHaveBeenCalledTimes(2);
  expect(env.gpu.dispose).not.toHaveBeenCalled();
});
