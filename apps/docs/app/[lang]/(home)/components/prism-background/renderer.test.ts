/**
 * Renderer lifecycle, against a mocked `vgpu`. This is the half of the example
 * that has nothing to do with optics: one frame loop, one mutable light buffer,
 * coalesced resizes, and a teardown that releases everything even when
 * initialization loses a race with `dispose()`.
 *
 * The physics is covered by `optics.test.ts` and, on a real device, by
 * `examples/prism-validation`.
 */

import { afterEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({ init: vi.fn() }));
const vgpuFns = vi.hoisted(() =>
  Object.fromEntries(
    [
      "surface",
      "target",
      "effect",
      "draw",
      "geometry",
      "sampler",
      "bundle",
      "compute",
      "storage",
      "uniforms",
      "timer",
      "visibility",
      "frame",
      "frameLoop",
    ]
      // Each test's gpu double carries its factory fakes in `fns`; these route the free functions to them.
      .map((name) => [
        name,
        (gpu: any, ...args: any[]) => gpu.fns[name](...args),
      ])
  )
) as Record<string, unknown>;
vi.mock("vgpu", () => ({
  init: mocks.init,
  ...vgpuFns,
  clock: (gpu: any) =>
    gpu.clock ?? { time: 0, deltaTime: 0, frameCount: 0, advance() {} },
}));

import { createRenderer } from "./renderer";
import { PRISM_DARK_DEBUG_SOURCE_IDS } from "./debug/sources";
import {
  LIGHT_INTERNAL_FIRST_VERTEX,
  LIGHT_INTERNAL_VERTICES,
  LIGHT_OUTGOING_FIRST_VERTEX,
  LIGHT_OUTGOING_VERTICES,
  LIGHT_VERTEX_STRIDE,
  LIGHT_WHITE_VERTICES,
  lightVertexCount,
} from "./scene/light-mesh";
import { LOW_LIGHT_MESH_LAYOUT } from "./pipelines/quality";
import { prismPlanes } from "./scene/prism-mesh";
import { darkWallClear } from "./pipelines/dark/passes/wall/clear";
import { schlickFresnelF0 } from "./runtime/uniforms";
import { wallExtent } from "./scene/scene";
import {
  CAMERA_DISTANCE,
  DEFAULT_PRISM_CONTROLS,
  PRISM_DEFAULT_ARC,
  PRISM_FRONT_Z,
  PRISM_LIGHT_PLANE_Z,
  PRISM_TRIANGLE,
} from "./types";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function partialDraw(pipeline: unknown, firstVertex: number, vertices: number) {
  return { pipeline, options: { firstVertex, vertices } };
}

function instancedDraw(pipeline: unknown, instances: number) {
  return { pipeline, options: { instances } };
}

function browser() {
  const windowListeners = new Map<string, EventListener>();
  const documentListeners = new Map<string, EventListener>();
  const canvasListeners = new Map<string, EventListener>();
  const frames = new Map<number, FrameRequestCallback>();
  let hidden = false;
  let nextFrame = 0;
  let canvasRect = {
    left: 0,
    top: 0,
    right: 200,
    bottom: 100,
    width: 200,
    height: 100,
  };
  vi.stubGlobal("window", {
    devicePixelRatio: 2,
    innerHeight: 768,
    addEventListener: vi.fn((name: string, listener: EventListener) =>
      windowListeners.set(name, listener)
    ),
    removeEventListener: vi.fn((name: string) => windowListeners.delete(name)),
  });
  vi.stubGlobal("document", {
    get hidden() {
      return hidden;
    },
    addEventListener: vi.fn((name: string, listener: EventListener) =>
      documentListeners.set(name, listener)
    ),
    removeEventListener: vi.fn((name: string) =>
      documentListeners.delete(name)
    ),
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
  const observe = vi.fn();
  let resizeCallback: ResizeObserverCallback | undefined;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: ResizeObserverCallback) {
        resizeCallback = callback;
      }
      observe = observe;
      disconnect = disconnect;
    }
  );
  const intersectionDisconnect = vi.fn();
  const intersectionObserve = vi.fn();
  let intersectionCallback: IntersectionObserverCallback | undefined;
  let intersectionOptions: IntersectionObserverInit | undefined;
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(
        callback: IntersectionObserverCallback,
        options?: IntersectionObserverInit
      ) {
        intersectionCallback = callback;
        intersectionOptions = options;
      }
      observe = intersectionObserve;
      disconnect = intersectionDisconnect;
    }
  );

  const captured = new Set<number>();
  const canvas = {
    getBoundingClientRect: () => canvasRect,
    addEventListener: vi.fn((name: string, listener: EventListener) =>
      canvasListeners.set(name, listener)
    ),
    removeEventListener: vi.fn((name: string) => canvasListeners.delete(name)),
    setPointerCapture: vi.fn((id: number) => captured.add(id)),
    hasPointerCapture: vi.fn((id: number) => captured.has(id)),
    releasePointerCapture: vi.fn((id: number) => captured.delete(id)),
  } as unknown as HTMLCanvasElement;
  const framingElement = {
    getBoundingClientRect: () => ({
      left: 100,
      top: 10,
      width: 90,
      height: 80,
    }),
  } as unknown as HTMLElement;
  return {
    canvas,
    framingElement,
    canvasListeners,
    windowListeners,
    documentListeners,
    frames,
    observe,
    disconnect,
    intersectionObserve,
    intersectionDisconnect,
    get intersectionOptions() {
      return intersectionOptions;
    },
    setHidden(next: boolean, dispatch = false) {
      hidden = next;
      if (dispatch) {
        const listener = documentListeners.get("visibilitychange");
        listener?.(new Event("visibilitychange"));
      }
    },
    setCanvasRect(next: Partial<typeof canvasRect>) {
      canvasRect = { ...canvasRect, ...next };
    },
    resizeObserved() {
      resizeCallback?.([], {} as ResizeObserver);
    },
    intersect(isIntersecting: boolean) {
      intersectionCallback?.(
        [
          {
            isIntersecting,
            target: canvas,
          } as unknown as IntersectionObserverEntry,
        ],
        {} as IntersectionObserver
      );
    },
    flushAnimationFrames(timestamp = 16) {
      const pending = [...frames.entries()];
      frames.clear();
      for (const [, callback] of pending) callback(timestamp);
    },
  };
}

function gpu(features: readonly GPUFeatureName[] = []) {
  const stop = vi.fn();
  const gpuClock = {
    time: 0,
    deltaTime: 0,
    frameCount: 0,
    advance: vi.fn(),
  };
  const encodedPasses: unknown[][] = [];
  const passOptions: unknown[] = [];
  const loopFrame = {
    pass: vi.fn((options: unknown, body: (pass: unknown) => void) => {
      passOptions.push(options);
      const encoded: unknown[] = [];
      body({
        draw: (pipeline: unknown, options?: unknown) =>
          encoded.push(options ? { pipeline, options } : pipeline),
        bundles: (recorded: { commands: unknown[] }) =>
          encoded.push(...recorded.commands),
      });
      encodedPasses.push(encoded);
    }),
  };
  const surface = {
    size: [200, 100] as number[],
    format: "bgra8unorm",
    // Mirrors the real surface: a resize changes the size the scene is sized from.
    resize: vi.fn((size: number[]) => {
      surface.size = size;
    }),
    dispose: vi.fn(),
  };
  const lightBuffer = {
    gpu: { destroy: vi.fn() },
    write: vi.fn(),
    destroy: vi.fn(),
  };
  const effects: {
    label?: string;
    set: ReturnType<typeof vi.fn>;
    compile: ReturnType<typeof vi.fn>;
  }[] = [];
  const draws: {
    label?: string;
    set: ReturnType<typeof vi.fn>;
    compile: ReturnType<typeof vi.fn>;
  }[] = [];
  const targets: {
    size: number[];
    format: string;
    sampleCount: 1 | 4;
    color: { gpu: object };
    msaa?: boolean | 4;
    resize: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
  }[] = [];
  const textures: {
    gpu: object;
    label?: string;
    options: Record<string, unknown>;
    destroy: ReturnType<typeof vi.fn>;
  }[] = [];
  const copyTextureToTexture = vi.fn();
  const finishEncoder = vi.fn(() => ({}));
  let nextCompileFailure: Error | undefined;
  const pipeline = (
    into: {
      label?: string;
      set: ReturnType<typeof vi.fn>;
      compile: ReturnType<typeof vi.fn>;
    }[],
    label?: string
  ) => {
    const created = {
      label,
      set: vi.fn(),
      compile: vi.fn(async () => {
        if (!nextCompileFailure) return;
        const failure = nextCompileFailure;
        nextCompileFailure = undefined;
        throw failure;
      }),
    };
    into.push(created);
    return created;
  };
  const instance = {
    clock: gpuClock,
    gpu: {
      queue: {
        onSubmittedWorkDone: vi.fn(async () => {}),
        submit: vi.fn(),
        writeTexture: vi.fn(),
      },
      createCommandEncoder: vi.fn(() => ({
        copyTextureToTexture,
        finish: finishEncoder,
      })),
    },
    device: {
      features: new Set<GPUFeatureName>(features),
      createBuffer: vi.fn(() => lightBuffer),
      createTexture: vi.fn((options: Record<string, unknown>) => {
        const created = {
          gpu: {},
          label: options.label as string | undefined,
          options,
          destroy: vi.fn(),
        };
        textures.push(created);
        return created;
      }),
    },
    settled: vi.fn(async () => {}),
    dispose: vi.fn(),
    fns: {
      surface: vi.fn(() => surface),
      sampler: vi.fn(() => ({})),
      geometry: vi.fn(() => ({ destroy: vi.fn() })),
      target: vi.fn(
        (options: { size: number[]; format?: string; msaa?: boolean | 4 }) => {
          const created = {
            size: [...options.size],
            format: options.format ?? "bgra8unorm",
            sampleCount: (options.msaa === true || options.msaa === 4
              ? 4
              : 1) as 1 | 4,
            color: { gpu: {} },
            msaa: options.msaa,
            resize: vi.fn((size: number[]) => {
              created.size = [...size];
            }),
            destroy: vi.fn(),
          };
          targets.push(created);
          return created;
        }
      ),
      effect: vi.fn((_source: unknown, options?: { label?: string }) =>
        pipeline(effects, options?.label)
      ),
      draw: vi.fn((options: { label?: string }) =>
        pipeline(draws, options.label)
      ),
      bundle: vi.fn(
        (
          _options: unknown,
          record: (recorder: {
            draw(pipeline: unknown, options?: unknown): void;
          }) => void
        ) => {
          const commands: unknown[] = [];
          record({
            draw: (created, options) =>
              commands.push(options ? { pipeline: created, options } : created),
          });
          return { commands };
        }
      ),
      // The free functions are routed with `gpu` stripped, so these fakes see
      // only the arguments after it.
      frame: vi.fn((callback: (frame: unknown) => void) =>
        callback({
          pass: (_options: unknown, body: (pass: unknown) => void) =>
            body({ draw: vi.fn() }),
        })
      ),
      frameLoop: vi.fn((_tick: (_frame: unknown) => void) => ({ stop })),
    },
  };
  return {
    instance,
    surface,
    lightBuffer,
    effects,
    draws,
    targets,
    textures,
    copyTextureToTexture,
    loopFrame,
    encodedPasses,
    passOptions,
    gpuClock,
    stop,
    failNextCompile(error: Error) {
      nextCompileFailure = error;
    },
  };
}

function drawNamed(live: ReturnType<typeof gpu>, label: string) {
  const found = live.draws.find((draw) => draw.label === label);
  if (!found) throw new Error(`Missing draw ${label}`);
  return found;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

test("renders the deterministic light once and idles until something changes", async () => {
  const env = browser();
  const live = gpu();
  mocks.init.mockResolvedValueOnce(live.instance);
  const renderer = createRenderer({ canvas: env.canvas, initialMode: "dark" });
  await renderer.ready;
  const darkLight = drawNamed(live, "prism-rainbow.light");
  const glassBack = drawNamed(live, "prism-rainbow.glass-back");
  const glassFront = drawNamed(live, "prism-rainbow.glass-front");
  const dust = drawNamed(live, "prism-rainbow.dust");

  expect(live.instance.fns.frameLoop).toHaveBeenCalledOnce();
  expect(live.instance.fns.bundle).toHaveBeenCalledOnce();
  // Runtime construction already knows the output aspect, so pipeline prepare
  // does not retrace the same light mesh. No history textures are allocated.
  expect(live.instance.device.createBuffer).toHaveBeenCalledOnce();
  expect(live.instance.device.createBuffer).toHaveBeenCalledWith(
    expect.objectContaining({
      size: lightVertexCount() * LIGHT_VERTEX_STRIDE,
    })
  );
  expect(live.lightBuffer.write).toHaveBeenCalledOnce();
  expect(live.effects).toHaveLength(16);
  expect(live.draws).toHaveLength(4);
  const darkDrawOptions = live.instance.fns.draw.mock.calls as unknown as [
    Record<string, unknown>
  ][];
  expect(darkDrawOptions.map(([options]) => options.label)).toEqual([
    "prism-rainbow.light",
    "prism-rainbow.glass-back",
    "prism-rainbow.glass-front",
    "prism-rainbow.dust",
  ]);
  expect(live.instance.fns.draw).toHaveBeenNthCalledWith(
    1,
    expect.objectContaining({
      geometry: expect.objectContaining({
        vertexBufferLayouts: [
          {
            arrayStride: 12,
            attributes: [
              { shaderLocation: 0, offset: 0, format: "float32x2" },
              { shaderLocation: 3, offset: 8, format: "float32" },
            ],
          },
        ],
      }),
    })
  );
  expect(live.instance.fns.draw).toHaveBeenNthCalledWith(
    2,
    expect.objectContaining({ blend: "premultiplied" })
  );
  expect(live.instance.fns.draw).toHaveBeenNthCalledWith(
    4,
    expect.objectContaining({
      vertices: 6,
      instances: 2200,
      depth: false,
      blend: "additive",
    })
  );
  expect(live.instance.fns.sampler).toHaveBeenNthCalledWith(2, {
    minFilter: "linear",
    magFilter: "linear",
    mipmapFilter: "linear",
    addressModeU: "repeat",
    addressModeV: "clamp-to-edge",
  });
  for (const created of [...live.effects, ...live.draws])
    expect(created.compile).toHaveBeenCalledOnce();
  // Canvas surfaces do not expose a current texture until a frame begins, so
  // output pipelines must pre-warm from the surface's stable format signature.
  expect(live.effects[13]!.compile).toHaveBeenCalledWith({
    colors: ["bgra8unorm"],
  });
  // A single-sample HDR backdrop holds back-side glass and light, while the
  // front-side target alone uses MSAA. Four pairs of
  // smaller HDR targets hold three bloom scales and one particle-light scale; the
  // display-encoded target retains the dark base underneath animated dust. The
  // remainder are transient studio-environment mip-bake surfaces. The debug
  // environment is not allocated by the production renderer.
  expect(live.targets).toHaveLength(26);
  expect(live.targets[0]!.format).toBe("rgba16float");
  expect(live.targets[1]!.format).toBe("rgba16float");
  expect(live.targets[0]!.msaa).toBeUndefined();
  expect(live.targets[1]!.msaa).toBe(true);
  expect(live.targets.slice(2, 10).map((entry) => entry.size)).toEqual([
    [100, 50],
    [100, 50],
    [50, 25],
    [50, 25],
    [25, 13],
    [25, 13],
    [13, 7],
    [13, 7],
  ]);
  for (const bloomTarget of live.targets.slice(2, 10)) {
    expect(bloomTarget.format).toBe("rgba16float");
    expect(bloomTarget.msaa).toBeUndefined();
  }
  expect(live.targets[10]).toEqual(
    expect.objectContaining({
      size: [200, 100],
      format: "bgra8unorm",
      msaa: undefined,
    })
  );
  expect(live.textures).toHaveLength(1);
  for (const environmentTexture of live.textures) {
    expect(environmentTexture.options).toEqual(
      expect.objectContaining({
        size: [1024, 512],
        format: "rgba16float",
        mipLevelCount: 8,
        usage: ["texture_binding", "copy_dst"],
      })
    );
  }
  expect(live.effects[14]!.compile).toHaveBeenCalledWith(live.targets[11]);
  expect(live.effects[15]!.compile).toHaveBeenCalledWith(live.targets[11]);
  expect(live.effects[14]!.set).toHaveBeenCalledWith({
    params: { debug: 0 },
  });
  expect(live.copyTextureToTexture).toHaveBeenCalledTimes(8);
  expect(live.effects[0]!.compile).toHaveBeenCalledWith(live.targets[1]);
  expect(live.effects[1]!.compile).toHaveBeenCalledWith(live.targets[3]);
  for (let level = 0; level < 4; level++) {
    expect(live.effects[level * 2 + 2]!.compile).toHaveBeenCalledWith(
      live.targets[level * 2 + 2]
    );
    expect(live.effects[level * 2 + 3]!.compile).toHaveBeenCalledWith(
      live.targets[level * 2 + 3]
    );
  }
  expect(live.effects[10]!.compile).toHaveBeenCalledWith(live.targets[2]);
  expect(live.effects[11]!.compile).toHaveBeenCalledWith(live.targets[9]);
  expect(darkLight.compile).toHaveBeenCalledWith(live.targets[0]);
  expect(glassBack.compile).toHaveBeenCalledWith(live.targets[0]);
  expect(glassFront.compile).toHaveBeenCalledWith(live.targets[1]);
  expect(dust.compile).toHaveBeenCalledWith({
    colors: ["bgra8unorm"],
  });
  expect(live.effects[0]!.set).toHaveBeenLastCalledWith({
    sceneTexture: live.targets[0],
  });
  expect(glassBack.set).toHaveBeenLastCalledWith(
    expect.objectContaining({
      studioEnvironment: live.textures[0],
      debugEnvironment: live.textures[0],
    })
  );
  expect(glassFront.set).toHaveBeenLastCalledWith(
    expect.objectContaining({
      sceneTexture: live.targets[0],
      studioEnvironment: live.textures[0],
      debugEnvironment: live.textures[0],
    })
  );
  const backGlassBindings = glassBack.set.mock.lastCall?.[0];
  const frontGlassBindings = glassFront.set.mock.lastCall?.[0];
  expect(backGlassBindings).toEqual(
    expect.objectContaining({
      params: expect.objectContaining({
        ior: 1.645,
        absorption: [1, 1, 0.54],
        fresnelF0: schlickFresnelF0(1.645),
        prismPlanes: prismPlanes(),
      }),
    })
  );
  expect(backGlassBindings).not.toHaveProperty("sceneTexture");
  expect(backGlassBindings).not.toHaveProperty("sceneSampler");
  expect(frontGlassBindings).toEqual(
    expect.objectContaining({ sceneTexture: live.targets[0] })
  );
  expect(frontGlassBindings).toHaveProperty("sceneSampler");
  expect(live.effects[1]!.set).toHaveBeenLastCalledWith(
    expect.objectContaining({ sourceTexture: live.targets[1] })
  );
  expect(live.effects[2]!.set).toHaveBeenLastCalledWith(
    expect.objectContaining({ sourceTexture: live.targets[3] })
  );
  expect(live.effects[3]!.set).toHaveBeenLastCalledWith(
    expect.objectContaining({ sourceTexture: live.targets[2] })
  );
  expect(live.effects[4]!.set).toHaveBeenLastCalledWith(
    expect.objectContaining({ sourceTexture: live.targets[3] })
  );
  expect(live.effects[10]!.set).toHaveBeenLastCalledWith(
    expect.objectContaining({
      level0Texture: live.targets[3],
      level1Texture: live.targets[5],
      level2Texture: live.targets[7],
    })
  );
  expect(live.effects[11]!.set).toHaveBeenLastCalledWith(
    expect.objectContaining({ sourceTexture: live.targets[1] })
  );
  expect(live.effects[12]!.set).toHaveBeenLastCalledWith(
    expect.objectContaining({
      sceneTexture: live.targets[1],
      bloomTexture: live.targets[2],
      params: { bloomStrength: 0.7 },
    })
  );
  expect(live.effects[12]!.compile).toHaveBeenCalledWith(live.targets[10]);
  expect(live.effects[13]!.set).toHaveBeenLastCalledWith({
    params: {
      backgroundColor: [0, 0, 0],
      revealProgress: 1,
    },
    sourceTexture: live.targets[10],
  });
  expect(darkLight.set).toHaveBeenLastCalledWith({
    scene: expect.objectContaining({ lightPlaneZ: PRISM_LIGHT_PLANE_Z }),
  });
  expect(dust.set).toHaveBeenLastCalledWith({
    params: expect.objectContaining({
      outputSize: [200, 100],
      time: 0,
      lightPlaneZ: PRISM_LIGHT_PLANE_Z,
      prismA: PRISM_TRIANGLE.a,
      prismB: PRISM_TRIANGLE.b,
      prismC: PRISM_TRIANGLE.c,
      prismFrontZ: PRISM_FRONT_Z,
    }),
    colorTexture: live.targets[5],
    lightTexture: live.targets[9],
    lightSampler: expect.anything(),
  });
  expect(
    (
      live.instance.fns.bundle.mock.results[0]?.value as {
        commands: unknown[];
      }
    ).commands
  ).toEqual([
    partialDraw(darkLight, 0, LIGHT_WHITE_VERTICES),
    partialDraw(
      darkLight,
      LIGHT_OUTGOING_FIRST_VERTEX,
      LIGHT_OUTGOING_VERTICES
    ),
    glassBack,
    partialDraw(
      darkLight,
      LIGHT_INTERNAL_FIRST_VERTEX,
      LIGHT_INTERNAL_VERTICES
    ),
  ]);

  const tick = live.instance.fns.frameLoop.mock.calls[0]![0];
  tick(live.loopFrame);
  // Fifteen standalone passes bake the studio environment pyramid once. Runtime
  // rendering encodes the sorted background, refractive front, highlight
  // extraction, six visible blur passes, the unthresholded particle reduction,
  // two broad particle blur passes, bloom composition, retained presentation
  // and the final copy-plus-dust output.
  expect(live.instance.fns.frame).toHaveBeenCalledTimes(15);
  expect(live.loopFrame.pass).toHaveBeenCalledTimes(15);
  expect(live.passOptions[0]).toEqual({
    target: live.targets[0],
    clear: darkWallClear(DEFAULT_PRISM_CONTROLS.wallColor, "glass"),
  });
  expect(live.encodedPasses).toEqual([
    [
      partialDraw(darkLight, 0, LIGHT_WHITE_VERTICES),
      partialDraw(
        darkLight,
        LIGHT_OUTGOING_FIRST_VERTEX,
        LIGHT_OUTGOING_VERTICES
      ),
      glassBack,
      partialDraw(
        darkLight,
        LIGHT_INTERNAL_FIRST_VERTEX,
        LIGHT_INTERNAL_VERTICES
      ),
    ],
    [live.effects[0], glassFront],
    [live.effects[1]],
    [live.effects[2]],
    [live.effects[3]],
    [live.effects[4]],
    [live.effects[5]],
    [live.effects[6]],
    [live.effects[7]],
    [live.effects[11]],
    [live.effects[8]],
    [live.effects[9]],
    [live.effects[10]],
    [live.effects[12]],
    [live.effects[13], instancedDraw(dust, 2200)],
  ]);
  tick(live.loopFrame);
  expect(live.loopFrame.pass).toHaveBeenCalledTimes(15);
  renderer.dispose();
});

test("requests supported packed bloom with optional performance timestamps", async () => {
  const env = browser();
  const requestAdapter = vi.fn(async () => ({
    features: new Set<GPUFeatureName>([
      "rg11b10ufloat-renderable",
      "timestamp-query",
    ]),
  }));
  vi.stubGlobal("navigator", { gpu: { requestAdapter } });
  const live = gpu(["rg11b10ufloat-renderable", "timestamp-query"]);
  mocks.init.mockResolvedValueOnce(live.instance);

  const renderer = createRenderer({
    canvas: env.canvas,
    initialMode: "dark",
    performanceSampling: true,
  });
  await renderer.ready;

  expect(requestAdapter).toHaveBeenCalledOnce();
  expect(mocks.init).toHaveBeenCalledWith(
    expect.objectContaining({
      adapter: expect.objectContaining({ requestDevice: expect.any(Function) }),
      requiredFeatures: ["rg11b10ufloat-renderable", "timestamp-query"],
    })
  );
  expect(live.targets.slice(2, 8).map(({ format }) => format)).toEqual(
    Array.from({ length: 6 }, () => "rg11b10ufloat")
  );
  expect(live.targets.slice(8, 10).map(({ format }) => format)).toEqual([
    "rgba16float",
    "rgba16float",
  ]);

  renderer.dispose();
});

test("retries without optional features when device creation rejects them", async () => {
  const env = browser();
  const requestAdapter = vi.fn(async () => ({
    features: new Set<GPUFeatureName>(["rg11b10ufloat-renderable"]),
  }));
  vi.stubGlobal("navigator", { gpu: { requestAdapter } });
  const live = gpu();
  mocks.init
    .mockRejectedValueOnce(new Error("optional feature unavailable"))
    .mockResolvedValueOnce(live.instance);

  const renderer = createRenderer({
    canvas: env.canvas,
    initialMode: "dark",
  });
  await renderer.ready;

  expect(requestAdapter).toHaveBeenCalledOnce();
  const reusedAdapter = mocks.init.mock.calls[0]![0]!.adapter;
  expect(mocks.init).toHaveBeenNthCalledWith(1, {
    adapter: reusedAdapter,
    requiredFeatures: ["rg11b10ufloat-renderable"],
  });
  expect(mocks.init).toHaveBeenNthCalledWith(2, { adapter: reusedAdapter });
  expect(live.targets.slice(2, 10).map(({ format }) => format)).toEqual(
    Array.from({ length: 8 }, () => "rgba16float")
  );
  renderer.dispose();
});

test("uses an explicit DPR only for performance sampling", async () => {
  const env = browser();
  Object.assign(window, {
    location: { search: "?prism-perf=light&prism-perf-dpr=2" },
  });
  vi.stubGlobal("navigator", {});
  const live = gpu();
  mocks.init.mockResolvedValueOnce(live.instance);

  const renderer = createRenderer({
    canvas: env.canvas,
    initialMode: "light",
    performanceSampling: true,
  });
  await renderer.ready;

  expect(live.instance.fns.surface).toHaveBeenCalledWith(env.canvas, {
    autoResize: false,
    dpr: 2,
  });
  renderer.dispose();
});

test.each(["dark", "light"] as const)(
  "uses DPR 1 for the low-quality %s pipeline",
  async (mode) => {
    const env = browser();
    vi.stubGlobal("navigator", {});
    const live = gpu();
    mocks.init.mockResolvedValueOnce(live.instance);
    const renderer = createRenderer({
      canvas: env.canvas,
      initialMode: mode,
      initialQuality: "low",
    });
    await renderer.ready;

    expect(live.instance.fns.surface).toHaveBeenCalledWith(env.canvas, {
      autoResize: false,
      dpr: 1,
    });
    env.flushAnimationFrames();
    expect(live.surface.resize).toHaveBeenLastCalledWith([200, 100]);
    renderer.dispose();
  }
);

test("remeasures the canvas when quality changes at runtime", async () => {
  const env = browser();
  vi.stubGlobal("navigator", {});
  const live = gpu();
  mocks.init.mockResolvedValueOnce(live.instance);
  const renderer = createRenderer({
    canvas: env.canvas,
    initialMode: "light",
  });
  await renderer.ready;

  env.flushAnimationFrames();
  expect(live.surface.resize).toHaveBeenLastCalledWith([400, 200]);

  await renderer.setQualityPreference("low");
  env.flushAnimationFrames();
  expect(live.surface.resize).toHaveBeenLastCalledWith([200, 100]);
  expect(
    (live.lightBuffer.write.mock.calls.at(-1)![0] as Float32Array).byteLength
  ).toBe(LOW_LIGHT_MESH_LAYOUT.vertexCount * LIGHT_VERTEX_STRIDE);

  await renderer.setQualityPreference("high");
  env.flushAnimationFrames();
  expect(live.surface.resize).toHaveBeenLastCalledWith([400, 200]);
  expect(
    (live.lightBuffer.write.mock.calls.at(-1)![0] as Float32Array).byteLength
  ).toBe(lightVertexCount() * LIGHT_VERTEX_STRIDE);
  renderer.dispose();
});

test("renders High before loading the deferred Auto controller", async () => {
  vi.useFakeTimers();
  const env = browser();
  const live = gpu();
  mocks.init.mockResolvedValueOnce(live.instance);
  const autoController = {
    recordFrame: vi.fn(),
    resetHealth: vi.fn(),
    dispose: vi.fn(),
  };
  const createAuto = vi.fn(() => autoController);
  const loadAutoQuality = vi.fn(async () => ({
    createPrismAutoQualityController: createAuto,
  }));
  const renderer = createRenderer({
    canvas: env.canvas,
    initialMode: "dark",
    loadAutoQuality,
  });
  await renderer.ready;
  env.flushAnimationFrames();
  const tick = live.instance.fns.frameLoop.mock.calls[0]![0];

  tick(live.loopFrame);
  expect(renderer.getQualityState()).toEqual({
    preference: "auto",
    effective: "high",
    reason: "initial",
  });
  expect(live.loopFrame.pass).toHaveBeenCalled();
  expect(loadAutoQuality).not.toHaveBeenCalled();

  env.flushAnimationFrames();
  expect(loadAutoQuality).not.toHaveBeenCalled();
  await vi.runOnlyPendingTimersAsync();
  expect(loadAutoQuality).toHaveBeenCalledOnce();
  expect(createAuto).toHaveBeenCalledOnce();
  renderer.dispose();
});

test("performance sampling never starts Auto", async () => {
  vi.useFakeTimers();
  const env = browser();
  vi.stubGlobal("navigator", {});
  const live = gpu();
  mocks.init.mockResolvedValueOnce(live.instance);
  const loadAutoQuality = vi.fn();
  const renderer = createRenderer({
    canvas: env.canvas,
    initialMode: "dark",
    performanceSampling: true,
    loadAutoQuality,
  });
  await renderer.ready;
  env.flushAnimationFrames();
  live.instance.fns.frameLoop.mock.calls[0]![0](live.loopFrame);
  env.flushAnimationFrames();
  await vi.runOnlyPendingTimersAsync();
  expect(loadAutoQuality).not.toHaveBeenCalled();
  renderer.dispose();
});

test("an explicit preference cancels a stale Auto import", async () => {
  vi.useFakeTimers();
  const env = browser();
  const live = gpu();
  const pendingAuto = deferred<{
    createPrismAutoQualityController: ReturnType<typeof vi.fn>;
  }>();
  const createAuto = vi.fn();
  const loadAutoQuality = vi.fn(() => pendingAuto.promise);
  mocks.init.mockResolvedValueOnce(live.instance);
  const renderer = createRenderer({
    canvas: env.canvas,
    initialMode: "dark",
    loadAutoQuality,
  });
  await renderer.ready;
  env.flushAnimationFrames();
  live.instance.fns.frameLoop.mock.calls[0]![0](live.loopFrame);
  env.flushAnimationFrames();
  await vi.runOnlyPendingTimersAsync();
  expect(loadAutoQuality).toHaveBeenCalledOnce();

  await renderer.setQualityPreference("high");
  pendingAuto.resolve({ createPrismAutoQualityController: createAuto });
  await pendingAuto.promise;
  await Promise.resolve();
  expect(createAuto).not.toHaveBeenCalled();
  expect(renderer.getQualityState()).toEqual({
    preference: "high",
    effective: "high",
    reason: "forced",
  });
  renderer.dispose();
});

test("forcing High supersedes an Auto Low preparation and restores DPR", async () => {
  vi.useFakeTimers();
  const env = browser();
  const live = gpu();
  let requestLow!: (reason: "gpu-tier") => void;
  const loadAutoQuality = vi.fn(async () => ({
    createPrismAutoQualityController: (options: {
      onDowngrade(reason: "gpu-tier"): void;
    }) => {
      requestLow = options.onDowngrade;
      return {
        recordFrame: vi.fn(),
        resetHealth: vi.fn(),
        dispose: vi.fn(),
      };
    },
  }));
  mocks.init.mockResolvedValueOnce(live.instance);
  const renderer = createRenderer({
    canvas: env.canvas,
    initialMode: "dark",
    loadAutoQuality,
  });
  await renderer.ready;
  env.flushAnimationFrames();
  live.instance.fns.frameLoop.mock.calls[0]![0](live.loopFrame);
  env.flushAnimationFrames();
  await vi.runOnlyPendingTimersAsync();

  requestLow("gpu-tier");
  expect(live.surface.resize).toHaveBeenLastCalledWith([200, 100]);
  await renderer.setQualityPreference("high");
  expect(renderer.getQualityState()).toEqual({
    preference: "high",
    effective: "high",
    reason: "forced",
  });
  expect(live.surface.resize).toHaveBeenLastCalledWith([400, 200]);
  renderer.dispose();
});

test("Auto downgrades once across theme changes and selecting Auto restarts High", async () => {
  vi.useFakeTimers();
  const env = browser();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Promise.reject(new Error("offline")))
  );
  const live = gpu();
  const downgrade: ((reason: "gpu-tier") => void)[] = [];
  const controllers: { dispose: ReturnType<typeof vi.fn> }[] = [];
  const qualityLogger = { info: vi.fn() };
  const loadAutoQuality = vi.fn(async () => ({
    createPrismAutoQualityController: (options: {
      onDowngrade(reason: "gpu-tier"): void;
    }) => {
      downgrade.push(options.onDowngrade);
      const controller = {
        recordFrame: vi.fn(),
        resetHealth: vi.fn(),
        dispose: vi.fn(),
      };
      controllers.push(controller);
      return controller;
    },
  }));
  mocks.init.mockResolvedValueOnce(live.instance);
  const renderer = createRenderer({
    canvas: env.canvas,
    initialMode: "dark",
    loadAutoQuality,
    qualityLogger,
  });
  await renderer.ready;
  env.flushAnimationFrames();
  const tick = live.instance.fns.frameLoop.mock.calls[0]![0];
  tick(live.loopFrame);
  env.flushAnimationFrames();
  await vi.runOnlyPendingTimersAsync();

  downgrade[0]!("gpu-tier");
  await vi.waitFor(() =>
    expect(renderer.getQualityState()).toEqual({
      preference: "auto",
      effective: "low",
      reason: "gpu-tier",
    })
  );
  expect(controllers[0]!.dispose).toHaveBeenCalledOnce();
  expect(qualityLogger.info).toHaveBeenCalledWith(
    "[Prism quality] Downgraded to Low.",
    {
      preference: "auto",
      reason: "gpu-tier",
      from: "high",
      to: "low",
      dpr: 1,
    }
  );

  await renderer.setMode("light");
  expect(renderer.getQualityState().effective).toBe("low");
  downgrade[0]!("gpu-tier");
  expect(renderer.getQualityState().effective).toBe("low");

  await renderer.setQualityPreference("auto");
  expect(renderer.getQualityState()).toEqual({
    preference: "auto",
    effective: "high",
    reason: "initial",
  });
  tick(live.loopFrame);
  env.flushAnimationFrames();
  await vi.runOnlyPendingTimersAsync();
  expect(loadAutoQuality).toHaveBeenCalledTimes(2);
  renderer.dispose();
});

test("applies DPR 1 before Low preparation and restores High DPR on failure", async () => {
  const env = browser();
  vi.stubGlobal("navigator", {});
  const live = gpu();
  mocks.init.mockResolvedValueOnce(live.instance);
  const renderer = createRenderer({
    canvas: env.canvas,
    initialMode: "light",
    initialQuality: "high",
  });
  await renderer.ready;
  env.flushAnimationFrames();
  expect(live.surface.resize).toHaveBeenLastCalledWith([400, 200]);

  live.failNextCompile(new Error("low shader failed"));
  const transition = renderer.setQualityPreference("low");
  expect(live.surface.resize).toHaveBeenLastCalledWith([200, 100]);
  await expect(transition).rejects.toThrow("low shader failed");
  expect(live.surface.resize).toHaveBeenLastCalledWith([400, 200]);
  expect(renderer.getQualityState().effective).toBe("high");
  renderer.dispose();
});

test("caps a 120 Hz interactive loop at 90 rendered frames", async () => {
  const env = browser();
  vi.stubGlobal("navigator", {});
  const live = gpu();
  live.gpuClock.deltaTime = 1 / 120;
  mocks.init.mockResolvedValueOnce(live.instance);
  const renderer = createRenderer({
    canvas: env.canvas,
    initialMode: "light",
  });
  await renderer.ready;
  const tick = live.instance.fns.frameLoop.mock.calls[0]![0];

  for (let sourceFrame = 0; sourceFrame < 120; sourceFrame++) {
    env.windowListeners.get("pointermove")?.({
      pointerId: 1,
      clientX: sourceFrame % 2 === 0 ? 0 : 200,
      clientY: sourceFrame % 3 === 0 ? 0 : 100,
    } as unknown as Event);
    tick(live.loopFrame);
  }

  // Light mode encodes three passes per rendered frame.
  expect(live.loopFrame.pass).toHaveBeenCalledTimes(90 * 3);
  renderer.dispose();
});

test.each([
  ["dark", 10],
  ["light", 3],
] as const)(
  "caps the low-quality %s pipeline at 60 rendered frames",
  async (mode, passesPerFrame) => {
    const env = browser();
    vi.stubGlobal("navigator", {});
    const live = gpu();
    live.gpuClock.deltaTime = 1 / 120;
    mocks.init.mockResolvedValueOnce(live.instance);
    const renderer = createRenderer({
      canvas: env.canvas,
      initialMode: mode,
      initialQuality: "low",
    });
    await renderer.ready;
    const tick = live.instance.fns.frameLoop.mock.calls[0]![0];

    for (let sourceFrame = 0; sourceFrame < 120; sourceFrame++) {
      env.windowListeners.get("pointermove")?.({
        pointerId: 1,
        clientX: sourceFrame % 2 === 0 ? 0 : 200,
        clientY: sourceFrame % 3 === 0 ? 0 : 100,
      } as unknown as Event);
      tick(live.loopFrame);
    }

    expect(live.loopFrame.pass).toHaveBeenCalledTimes(60 * passesPerFrame);
    renderer.dispose();
  }
);

test("uses the reduced shared GPU layout for low-quality light", async () => {
  const env = browser();
  vi.stubGlobal("navigator", {});
  const live = gpu();
  mocks.init.mockResolvedValueOnce(live.instance);
  const renderer = createRenderer({
    canvas: env.canvas,
    initialMode: "light",
    initialQuality: "low",
  });
  await renderer.ready;

  expect(
    live.targets.slice(0, 2).map(({ sampleCount }) => sampleCount)
  ).toEqual([1, 4]);
  expect(
    (live.lightBuffer.write.mock.calls[0]![0] as Float32Array).byteLength
  ).toBe(LOW_LIGHT_MESH_LAYOUT.vertexCount * LIGHT_VERTEX_STRIDE);
  expect(
    drawNamed(live, "prism-rainbow.light.wall").set
  ).toHaveBeenLastCalledWith(
    expect.objectContaining({ wallMaterial: expect.anything() })
  );
  expect(
    (
      live.instance.fns.bundle.mock.results[0]?.value as {
        commands: unknown[];
      }
    ).commands
  ).toEqual([
    live.draws[0],
    live.draws[1],
    partialDraw(live.draws[2], 0, LOW_LIGHT_MESH_LAYOUT.whiteVertices),
    partialDraw(
      live.draws[2],
      LOW_LIGHT_MESH_LAYOUT.outgoingFirstVertex,
      LOW_LIGHT_MESH_LAYOUT.outgoingVertices
    ),
    live.draws[3],
    partialDraw(
      live.draws[2],
      LOW_LIGHT_MESH_LAYOUT.internalFirstVertex,
      LOW_LIGHT_MESH_LAYOUT.internalVertices
    ),
  ]);
  const mesh = renderer
    .debugSources()
    .find(({ id }) => id === "spectral-light-mesh");
  expect(mesh?.details).toEqual(
    expect.arrayContaining([
      { label: "Sampling", value: "64 wavelengths × 12 beam slices" },
    ])
  );
  const wall = renderer.debugSources().find(({ id }) => id === "composed-wall");
  expect(wall?.details).toEqual(
    expect.arrayContaining([
      {
        label: "Material",
        value:
          "flat albedo + large normal · no micro-normal / roughness / specular",
      },
    ])
  );
  renderer.dispose();
});

test("removes the far bloom and particle-light targets in low-quality dark", async () => {
  const env = browser();
  vi.stubGlobal("navigator", {});
  const live = gpu();
  mocks.init.mockResolvedValueOnce(live.instance);
  const renderer = createRenderer({
    canvas: env.canvas,
    initialMode: "dark",
    initialQuality: "low",
  });
  await renderer.ready;

  expect(live.targets).toHaveLength(22);
  expect(live.effects).toHaveLength(11);
  expect(
    live.targets.slice(0, 2).map(({ sampleCount }) => sampleCount)
  ).toEqual([1, 4]);
  expect(live.effects[7]!.set).toHaveBeenLastCalledWith(
    expect.objectContaining({ params: { bloomStrength: 0.15 } })
  );
  const sourceIds = renderer.debugSources().map(({ id }) => id);
  expect(sourceIds).not.toContain("dark-bloom-2");
  expect(sourceIds).not.toContain("dark-particle-light");
  const dust = drawNamed(live, "prism-rainbow.dust");
  expect(dust.set).toHaveBeenLastCalledWith(
    expect.objectContaining({
      colorTexture: live.targets[5],
      lightTexture: live.targets[5],
    })
  );
  expect(
    (
      live.instance.fns.bundle.mock.results[0]?.value as {
        commands: unknown[];
      }
    ).commands
  ).toEqual([
    partialDraw(live.draws[0], 0, LOW_LIGHT_MESH_LAYOUT.whiteVertices),
    partialDraw(
      live.draws[0],
      LOW_LIGHT_MESH_LAYOUT.outgoingFirstVertex,
      LOW_LIGHT_MESH_LAYOUT.outgoingVertices
    ),
    live.draws[1],
    partialDraw(
      live.draws[0],
      LOW_LIGHT_MESH_LAYOUT.internalFirstVertex,
      LOW_LIGHT_MESH_LAYOUT.internalVertices
    ),
  ]);
  renderer.dispose();
});

test("caps the automatic mobile beam at 30 rendered frames", async () => {
  const env = browser();
  Object.assign(window, {
    matchMedia: vi.fn(() => ({ matches: true })),
  });
  vi.stubGlobal("navigator", {});
  const live = gpu();
  live.gpuClock.deltaTime = 1 / 120;
  mocks.init.mockResolvedValueOnce(live.instance);
  const renderer = createRenderer({
    canvas: env.canvas,
    initialMode: "light",
  });
  await renderer.ready;
  const tick = live.instance.fns.frameLoop.mock.calls[0]![0];

  for (let sourceFrame = 0; sourceFrame < 120; sourceFrame++) {
    live.gpuClock.time = sourceFrame / 120;
    tick(live.loopFrame);
  }

  // Light mode encodes three passes per rendered frame.
  expect(live.loopFrame.pass).toHaveBeenCalledTimes(30 * 3);
  renderer.dispose();
});

test("debug previews opt into the orientation environment", async () => {
  const env = browser();
  const live = gpu();
  mocks.init.mockResolvedValueOnce(live.instance);
  const renderer = createRenderer({
    canvas: env.canvas,
    initialMode: "dark",
    debugPreviews: true,
  });
  await renderer.ready;

  expect(live.textures.map(({ label }) => label)).toEqual([
    "prism-rainbow.environment-studio.texture",
    "prism-rainbow.environment-debug.texture",
  ]);
  renderer.setControls?.({
    ...DEFAULT_PRISM_CONTROLS,
    environmentDebug: true,
  });
  const tick = live.instance.fns.frameLoop.mock.calls[0]![0];
  tick(live.loopFrame);
  expect(
    drawNamed(live, "prism-rainbow.glass-back").set
  ).toHaveBeenLastCalledWith(
    expect.objectContaining({
      params: expect.objectContaining({ environmentDebug: 1 }),
      studioEnvironment: live.textures[0],
      debugEnvironment: live.textures[1],
    })
  );
  renderer.dispose();
});

test("an explicit light mode uses the lean pipeline and never schedules dust-only frames", async () => {
  const env = browser();
  const live = gpu();
  const controls = {
    ...DEFAULT_PRISM_CONTROLS,
    glass: {
      ...DEFAULT_PRISM_CONTROLS.glass,
      transmission: {
        dark: { ior: 1.81, absorption: [0.7, 0.6, 0.5] },
        light: { ior: 1.47, absorption: [0.1, 0.05, 0] },
      },
    },
  } satisfies typeof DEFAULT_PRISM_CONTROLS;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Promise.reject(new Error("offline")))
  );
  mocks.init.mockResolvedValueOnce(live.instance);
  const renderer = createRenderer({
    canvas: env.canvas,
    initialMode: "light",
    initialControls: controls,
  });
  await renderer.ready;

  expect(live.instance.fns.bundle).toHaveBeenCalledOnce();
  expect(live.effects).toHaveLength(4);
  expect(live.draws).toHaveLength(6);
  expect(live.targets).toHaveLength(17);
  expect(live.targets.slice(0, 2).map(({ size }) => size)).toEqual([
    [200, 100],
    [200, 100],
  ]);
  expect(live.targets.slice(0, 2).map(({ msaa }) => msaa)).toEqual([
    undefined,
    4,
  ]);
  const lightDrawOptions = live.instance.fns.draw.mock.calls as unknown as [
    Record<string, unknown>
  ][];
  expect(lightDrawOptions.map(([options]) => options.label)).toEqual([
    "prism-rainbow.light.wall",
    "prism-rainbow.light.prism-cast-shadow",
    "prism-rainbow.light.projected-caustic",
    "prism-rainbow.light.glass-back",
    "prism-rainbow.light.glass-front",
    "prism-rainbow.light.glass-accent",
  ]);
  expect(lightDrawOptions.some(([options]) => "instances" in options)).toBe(
    false
  );
  expect(renderer.debugSources().at(-1)?.id).toBe("final-output");

  const tick = live.instance.fns.frameLoop.mock.calls[0]![0];
  tick(live.loopFrame);
  expect(live.loopFrame.pass).toHaveBeenCalledTimes(3);
  for (const glassDraw of live.draws.slice(3, 6)) {
    expect(glassDraw!.set).toHaveBeenLastCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({
          ior: 1.47,
          absorption: [0.1, 0.05, 0],
          fresnelF0: schlickFresnelF0(1.47),
          prismPlanes: prismPlanes(),
        }),
      })
    );
  }
  expect(live.encodedPasses).toEqual([
    [
      live.draws[0],
      live.draws[1],
      partialDraw(live.draws[2], 0, LIGHT_WHITE_VERTICES),
      partialDraw(
        live.draws[2],
        LIGHT_OUTGOING_FIRST_VERTEX,
        LIGHT_OUTGOING_VERTICES
      ),
      live.draws[3],
      partialDraw(
        live.draws[2],
        LIGHT_INTERNAL_FIRST_VERTEX,
        LIGHT_INTERNAL_VERTICES
      ),
    ],
    [live.effects[0], live.draws[4], live.draws[5]],
    [live.effects[1]],
  ]);
  live.gpuClock.time = 1 / 30;
  tick(live.loopFrame);
  expect(live.loopFrame.pass).toHaveBeenCalledTimes(4);
  expect(live.encodedPasses.at(-1)).toEqual([live.effects[1]]);
  expect(live.effects[1]!.set).toHaveBeenLastCalledWith({
    sceneTexture: live.targets[1],
    params: expect.objectContaining({
      revealProgress: 1 - (1 - 1 / 30) ** 3,
    }),
  });

  live.gpuClock.time = 1;
  tick(live.loopFrame);
  expect(live.loopFrame.pass).toHaveBeenCalledTimes(7);
  expect(live.effects[1]!.set).toHaveBeenLastCalledWith({
    sceneTexture: live.targets[1],
    params: expect.objectContaining({
      backgroundColor: [250 / 255, 250 / 255, 250 / 255],
      revealProgress: 1,
    }),
  });

  live.gpuClock.time = 2.5;
  tick(live.loopFrame);
  expect(live.loopFrame.pass).toHaveBeenCalledTimes(10);
  expect(live.draws[2]!.set).toHaveBeenLastCalledWith(
    expect.objectContaining({
      scene: expect.objectContaining({ beamWidthReveal: 1 }),
    })
  );

  live.gpuClock.time = 3;
  tick(live.loopFrame);
  expect(live.loopFrame.pass).toHaveBeenCalledTimes(10);

  renderer.dispose();
});

test("dust-only animation frames reuse the resolved scene and bloom", async () => {
  const env = browser();
  const live = gpu();
  mocks.init.mockResolvedValueOnce(live.instance);
  const renderer = createRenderer({ canvas: env.canvas, initialMode: "dark" });
  await renderer.ready;
  const tick = live.instance.fns.frameLoop.mock.calls[0]![0];
  const dust = drawNamed(live, "prism-rainbow.dust");

  tick(live.loopFrame);
  expect(live.loopFrame.pass).toHaveBeenCalledTimes(15);

  // Finish the one-shot reveal before measuring the retained dust path. The
  // source scene intentionally redraws while its beam aperture is opening.
  live.gpuClock.time = 2.5;
  tick(live.loopFrame);
  expect(live.loopFrame.pass).toHaveBeenCalledTimes(30);
  const effectSetCounts = live.effects.map(({ set }) => set.mock.calls.length);
  const drawSetCounts = new Map(
    live.draws.map((draw) => [draw, draw.set.mock.calls.length])
  );

  live.gpuClock.time = 2.5 + 1 / 30;
  tick(live.loopFrame);

  expect(live.loopFrame.pass).toHaveBeenCalledTimes(31);
  expect(live.encodedPasses.at(-1)).toEqual([
    live.effects[13],
    instancedDraw(dust, 2200),
  ]);
  expect(dust.set).toHaveBeenLastCalledWith({
    params: {
      time: 76 / 30,
    },
  });
  live.effects
    .slice(0, 13)
    .forEach(({ set }, index) =>
      expect(set).toHaveBeenCalledTimes(effectSetCounts[index]!)
    );
  expect(live.effects[13]!.set).toHaveBeenCalledTimes(effectSetCounts[13]!);
  live.draws.forEach((draw) =>
    expect(draw.set).toHaveBeenCalledTimes(
      drawSetCounts.get(draw)! + (draw === dust ? 1 : 0)
    )
  );
  expect(live.lightBuffer.write).toHaveBeenCalledOnce();
  renderer.dispose();
});

test("dark-dust performance samples never rebuild the retained scene", async () => {
  const env = browser();
  const live = gpu();
  vi.stubGlobal("navigator", {});
  mocks.init.mockResolvedValueOnce(live.instance);
  const renderer = createRenderer({
    canvas: env.canvas,
    initialMode: "dark",
    performanceSampling: true,
  });
  await renderer.ready;
  const tick = live.instance.fns.frameLoop.mock.calls[0]![0];
  const dust = drawNamed(live, "prism-rainbow.dust");

  // Leave pending pointer input behind: the scenario must not consume it or
  // rebuild scene/light state while measuring the retained overlay.
  env.windowListeners.get("pointermove")?.({
    pointerId: 1,
    clientX: 15,
    clientY: 85,
  } as unknown as Event);
  const reportPromise = renderer.measurePerformance({
    scenario: "dark-dust",
    frames: 2,
    warmupFrames: 0,
  });
  await Promise.resolve();

  tick(live.loopFrame);
  expect(live.loopFrame.pass).toHaveBeenCalledTimes(15);
  const effectSetCounts = live.effects.map(({ set }) => set.mock.calls.length);
  const drawSetCounts = new Map(
    live.draws.map((draw) => [draw, draw.set.mock.calls.length])
  );

  tick(live.loopFrame);
  tick(live.loopFrame);
  const report = await reportPromise;

  expect(live.loopFrame.pass).toHaveBeenCalledTimes(17);
  expect(live.encodedPasses.slice(-2)).toEqual([
    [live.effects[13], instancedDraw(dust, 2200)],
    [live.effects[13], instancedDraw(dust, 2200)],
  ]);
  live.effects.forEach(({ set }, index) =>
    expect(set).toHaveBeenCalledTimes(effectSetCounts[index]!)
  );
  live.draws
    .filter((draw) => draw !== dust)
    .forEach((draw) =>
      expect(draw.set).toHaveBeenCalledTimes(drawSetCounts.get(draw)!)
    );
  expect(dust.set.mock.calls.slice(-2)).toEqual([
    [{ params: { time: 1 / 30 } }],
    [{ params: { time: 2 / 30 } }],
  ]);
  expect(live.lightBuffer.write).toHaveBeenCalledOnce();
  expect(report).toMatchObject({
    mode: "dark",
    scenario: "dark-dust",
    requested: { frames: 2, warmupFrames: 1 },
    recordedFrames: 2,
    lightMesh: { rebuilds: 0 },
    passes: { "dark.output": { encodedFrames: 2 } },
  });
  expect(Object.keys(report.passes)).toEqual(["dark.output"]);

  renderer.dispose();
});

test("the Pass A view keeps the sorted light around the environment-only back face", async () => {
  const env = browser();
  const live = gpu();
  mocks.init.mockResolvedValueOnce(live.instance);
  const renderer = createRenderer({ canvas: env.canvas, initialMode: "dark" });
  await renderer.ready;
  const tick = live.instance.fns.frameLoop.mock.calls[0]![0];
  const darkLight = drawNamed(live, "prism-rainbow.light");
  const glassBack = drawNamed(live, "prism-rainbow.glass-back");

  const controls = {
    ...DEFAULT_PRISM_CONTROLS,
    view: "back" as const,
    wallColor: "#102080",
  };
  renderer.setControls?.(controls);
  tick(live.loopFrame);

  expect(live.passOptions[0]).toEqual({
    target: live.targets[0],
    clear: darkWallClear(controls.wallColor, controls.view),
  });
  expect(live.encodedPasses).toEqual([
    [
      partialDraw(darkLight, 0, LIGHT_WHITE_VERTICES),
      partialDraw(
        darkLight,
        LIGHT_OUTGOING_FIRST_VERTEX,
        LIGHT_OUTGOING_VERTICES
      ),
      glassBack,
      partialDraw(
        darkLight,
        LIGHT_INTERNAL_FIRST_VERTEX,
        LIGHT_INTERNAL_VERTICES
      ),
    ],
    [live.effects[0]],
    [live.effects[1]],
    [live.effects[2]],
    [live.effects[3]],
    [live.effects[4]],
    [live.effects[5]],
    [live.effects[6]],
    [live.effects[7]],
    [live.effects[11]],
    [live.effects[8]],
    [live.effects[9]],
    [live.effects[10]],
    [live.effects[12]],
    [live.effects[13]],
  ]);
  renderer.dispose();
});

test("dark debug paths clear the wall and create wireframes only on demand", async () => {
  const env = browser();
  const live = gpu();
  mocks.init.mockResolvedValueOnce(live.instance);
  const renderer = createRenderer({ canvas: env.canvas, initialMode: "dark" });
  await renderer.ready;
  const controls = {
    ...DEFAULT_PRISM_CONTROLS,
    view: "wall" as const,
    wallColor: "#102080",
  };
  renderer.setControls?.(controls);

  const tick = live.instance.fns.frameLoop.mock.calls[0]![0];
  tick(live.loopFrame);

  expect(live.passOptions[0]).toEqual({
    target: live.targets[0],
    clear: darkWallClear(controls.wallColor, controls.view),
  });
  expect(live.encodedPasses[0]).toEqual([]);

  const wireframeControls = {
    ...controls,
    view: "glass" as const,
    lightWireframe: true,
  };
  renderer.setControls?.(wireframeControls);
  const nextPass = live.passOptions.length;
  tick(live.loopFrame);
  const lightWireframe = drawNamed(live, "prism-rainbow.light-wireframe");
  expect(live.passOptions[nextPass]).toEqual({
    target: live.targets[0],
    clear: darkWallClear(wireframeControls.wallColor, wireframeControls.view),
  });
  expect(live.draws.some(({ label }) => label === "prism-rainbow.wall")).toBe(
    false
  );
  expect(live.instance.fns.geometry).toHaveBeenCalledOnce();
  expect(live.encodedPasses[nextPass]).toContainEqual(
    partialDraw(lightWireframe, 0, LIGHT_WHITE_VERTICES)
  );

  renderer.setControls?.({
    ...wireframeControls,
    lightWireframe: false,
    wireframe: true,
  });
  const wireframePass = live.passOptions.length;
  tick(live.loopFrame);
  const prismWireframe = drawNamed(live, "prism-rainbow.wireframe");
  expect(live.instance.fns.geometry).toHaveBeenCalledTimes(2);
  expect(live.encodedPasses[wireframePass + 1]).toContain(prismWireframe);
  renderer.dispose();
});

test("the light wireframe reveals every generated triangle in the light-only view", async () => {
  const env = browser();
  const live = gpu();
  mocks.init.mockResolvedValueOnce(live.instance);
  const renderer = createRenderer({ canvas: env.canvas, initialMode: "dark" });
  await renderer.ready;
  const tick = live.instance.fns.frameLoop.mock.calls[0]![0];

  renderer.setControls?.({
    ...DEFAULT_PRISM_CONTROLS,
    view: "caustic",
    wallColor: "#ffffff",
    lightWireframe: true,
  });
  tick(live.loopFrame);
  const lightWireframe = drawNamed(live, "prism-rainbow.light-wireframe");

  expect(live.passOptions[0]).toEqual({
    target: live.targets[0],
    clear: [0, 0, 0, 1],
  });
  expect(live.encodedPasses[0]).toEqual([
    partialDraw(live.draws[0], 0, LIGHT_WHITE_VERTICES),
    partialDraw(
      live.draws[0],
      LIGHT_OUTGOING_FIRST_VERTEX,
      LIGHT_OUTGOING_VERTICES
    ),
    partialDraw(lightWireframe, 0, LIGHT_WHITE_VERTICES),
    partialDraw(
      lightWireframe,
      LIGHT_OUTGOING_FIRST_VERTEX,
      LIGHT_OUTGOING_VERTICES
    ),
    partialDraw(
      live.draws[0],
      LIGHT_INTERNAL_FIRST_VERTEX,
      LIGHT_INTERNAL_VERTICES
    ),
    partialDraw(
      lightWireframe,
      LIGHT_INTERNAL_FIRST_VERTEX,
      LIGHT_INTERNAL_VERTICES
    ),
  ]);
  expect(lightWireframe.set).toHaveBeenLastCalledWith({
    scene: expect.objectContaining({ lightPlaneZ: PRISM_LIGHT_PLANE_Z }),
  });
  renderer.dispose();
});

test("pointer position smoothly moves the lamp and its target without dragging", async () => {
  const env = browser();
  const live = gpu();
  mocks.init.mockResolvedValueOnce(live.instance);
  const renderer = createRenderer({ canvas: env.canvas, initialMode: "dark" });
  await renderer.ready;
  const tick = live.instance.fns.frameLoop.mock.calls[0]![0];
  const writesBeforeMove = live.lightBuffer.write.mock.calls.length;
  const retainedVertices = live.lightBuffer.write.mock.calls[0]![0];

  env.windowListeners.get("pointermove")?.({
    pointerId: 4,
    clientX: 20,
    clientY: 10,
  } as unknown as Event);
  expect(live.lightBuffer.write).toHaveBeenCalledTimes(writesBeforeMove);
  tick(live.loopFrame);
  expect(live.lightBuffer.write).toHaveBeenCalledTimes(writesBeforeMove + 1);
  tick(live.loopFrame);
  expect(live.lightBuffer.write).toHaveBeenCalledTimes(writesBeforeMove + 2);

  env.windowListeners.get("pointermove")?.({
    pointerId: 9,
    clientX: 180,
    clientY: 90,
  } as unknown as Event);
  expect(live.lightBuffer.write).toHaveBeenCalledTimes(writesBeforeMove + 2);
  tick(live.loopFrame);
  expect(live.lightBuffer.write).toHaveBeenCalledTimes(writesBeforeMove + 3);
  expect(
    live.lightBuffer.write.mock.calls.every(
      ([vertices]) => vertices === retainedVertices
    )
  ).toBe(true);
  expect(env.canvas.setPointerCapture).not.toHaveBeenCalled();
  renderer.dispose();
});

test("only optical controls rebuild the light mesh", async () => {
  const env = browser();
  const live = gpu();
  mocks.init.mockResolvedValueOnce(live.instance);
  const renderer = createRenderer({ canvas: env.canvas, initialMode: "dark" });
  await renderer.ready;
  const tick = live.instance.fns.frameLoop.mock.calls[0]![0];
  const writes = live.lightBuffer.write.mock.calls.length;
  const glassBack = drawNamed(live, "prism-rainbow.glass-back");
  const dust = drawNamed(live, "prism-rainbow.dust");

  // Peeling a layer off only changes how the same mesh is composited.
  renderer.setControls?.({ ...DEFAULT_PRISM_CONTROLS, view: "caustic" });
  expect(live.lightBuffer.write).toHaveBeenCalledTimes(writes);
  // Wall paint changes the composite, not the optical path.
  renderer.setControls?.({
    ...DEFAULT_PRISM_CONTROLS,
    view: "caustic",
    wallColor: "#101216",
  });
  expect(live.lightBuffer.write).toHaveBeenCalledTimes(writes);
  // Wireframe only adds an overlay draw over the already-generated prism.
  renderer.setControls?.({
    ...DEFAULT_PRISM_CONTROLS,
    view: "glass",
    wireframe: true,
  });
  expect(live.lightBuffer.write).toHaveBeenCalledTimes(writes);
  // Production ignores the diagnostic toggle and cannot retrace light.
  renderer.setControls?.({
    ...DEFAULT_PRISM_CONTROLS,
    environmentDebug: true,
  });
  expect(live.lightBuffer.write).toHaveBeenCalledTimes(writes);
  tick(live.loopFrame);
  expect(glassBack.set).toHaveBeenLastCalledWith(
    expect.objectContaining({
      params: expect.objectContaining({ environmentDebug: 0 }),
    })
  );
  // Glass material sliders update uniforms without retracing the spectral mesh.
  renderer.setControls?.({
    ...DEFAULT_PRISM_CONTROLS,
    glass: {
      ...DEFAULT_PRISM_CONTROLS.glass,
      transmission: {
        ...DEFAULT_PRISM_CONTROLS.glass.transmission,
        dark: {
          ior: 1.72,
          absorption: [0.2, 0.15, 0.1],
        },
      },
    },
  });
  tick(live.loopFrame);
  expect(live.lightBuffer.write).toHaveBeenCalledTimes(writes);
  expect(glassBack.set).toHaveBeenLastCalledWith(
    expect.objectContaining({
      params: expect.objectContaining({
        ior: 1.72,
        absorption: [0.2, 0.15, 0.1],
        fresnelF0: schlickFresnelF0(1.72),
      }),
    })
  );
  // Bloom runs on the already-rendered HDR image; its controls only update
  // postprocess uniforms and leave the traced light mesh untouched.
  renderer.setControls?.({
    ...DEFAULT_PRISM_CONTROLS,
    postprocess: {
      ...DEFAULT_PRISM_CONTROLS.postprocess,
      bloomStrength: 1.8,
      bloomThreshold: 0.4,
      bloomRadius: 4,
    },
  });
  tick(live.loopFrame);
  expect(live.lightBuffer.write).toHaveBeenCalledTimes(writes);
  expect(live.effects[1]!.set).toHaveBeenLastCalledWith(
    expect.objectContaining({
      params: expect.objectContaining({
        threshold: 0.4,
      }),
    })
  );
  expect(live.effects[10]!.set).toHaveBeenLastCalledWith(
    expect.objectContaining({
      params: expect.objectContaining({ radius: 1 }),
    })
  );
  expect(live.effects[12]!.set).toHaveBeenLastCalledWith(
    expect.objectContaining({
      params: { bloomStrength: 1.8 },
    })
  );
  expect(dust.set).toHaveBeenLastCalledWith(
    expect.objectContaining({
      params: expect.objectContaining({
        outputSize: [200, 100],
        prismA: PRISM_TRIANGLE.a,
        prismB: PRISM_TRIANGLE.b,
        prismC: PRISM_TRIANGLE.c,
      }),
    })
  );
  expect(live.encodedPasses.at(-1)).toEqual([
    live.effects[13],
    instancedDraw(dust, 2200),
  ]);
  // A different index of refraction bends every ribbon differently.
  renderer.setControls?.({
    ...DEFAULT_PRISM_CONTROLS,
    dispersion: "flint",
    view: "caustic",
  });
  expect(live.lightBuffer.write).toHaveBeenCalledTimes(writes + 1);
  // Changing the physical beam width retraces its boundary and profile rays.
  renderer.setControls?.({
    ...DEFAULT_PRISM_CONTROLS,
    dispersion: "flint",
    view: "caustic",
    beamWidth: 0.14,
  });
  expect(live.lightBuffer.write).toHaveBeenCalledTimes(writes + 2);
  // Custom Cauchy coefficients let the debug GUI tune the optical material
  // without changing the visible prism geometry.
  renderer.setControls?.({
    ...DEFAULT_PRISM_CONTROLS,
    spectralDispersion: { base: 1.3, strength: 0.025 },
    view: "caustic",
  });
  expect(live.lightBuffer.write).toHaveBeenCalledTimes(writes + 3);
  // The two pointer-Y endpoints change the incidence used to retrace the beam.
  renderer.setControls?.({
    ...DEFAULT_PRISM_CONTROLS,
    beamMouseY: { top: -52, bottom: 68 },
  });
  expect(live.lightBuffer.write).toHaveBeenCalledTimes(writes + 4);
  renderer.dispose();
});

test("fade controls rebuild only the data that cannot stay in the shader", async () => {
  const env = browser();
  const live = gpu();
  mocks.init.mockResolvedValueOnce(live.instance);
  const renderer = createRenderer({ canvas: env.canvas, initialMode: "dark" });
  await renderer.ready;
  const tick = live.instance.fns.frameLoop.mock.calls[0]![0];
  const writes = live.lightBuffer.write.mock.calls.length;
  const darkLight = drawNamed(live, "prism-rainbow.light");

  renderer.setControls?.({
    ...DEFAULT_PRISM_CONTROLS,
    lightFade: {
      beamOpacity: 0.35,
      edgeFalloff: 10,
      rainbowFalloffRate: 3.2,
      rainbowFalloffPower: 2,
    },
  });
  expect(live.lightBuffer.write).toHaveBeenCalledTimes(writes + 1);

  renderer.setControls?.({
    ...DEFAULT_PRISM_CONTROLS,
    lightFade: {
      beamOpacity: 0.35,
      edgeFalloff: 10,
      rainbowFalloffRate: 5.5,
      rainbowFalloffPower: 4.25,
    },
  });
  expect(live.lightBuffer.write).toHaveBeenCalledTimes(writes + 1);
  tick(live.loopFrame);
  expect(darkLight.set).toHaveBeenLastCalledWith({
    scene: expect.objectContaining({
      lightEdgeFalloff: 10,
      rainbowFalloffRate: 5.5,
      rainbowFalloffPower: 4.25,
      lightOpacity: 0.35,
    }),
  });
  renderer.dispose();
});

test("FOV updates the automatically distanced camera boundary", async () => {
  const env = browser();
  const live = gpu();
  mocks.init.mockResolvedValueOnce(live.instance);
  const renderer = createRenderer({ canvas: env.canvas, initialMode: "dark" });
  await renderer.ready;
  const tick = live.instance.fns.frameLoop.mock.calls[0]![0];
  const writes = live.lightBuffer.write.mock.calls.length;
  const darkLight = drawNamed(live, "prism-rainbow.light");
  const cameraFov = 56;

  renderer.setControls?.({
    ...DEFAULT_PRISM_CONTROLS,
    cameraFov,
  });
  expect(live.lightBuffer.write).toHaveBeenCalledTimes(writes + 1);
  tick(live.loopFrame);
  expect(darkLight.set).toHaveBeenLastCalledWith({
    scene: expect.objectContaining({
      wallHalfExtent: wallExtent(2, CAMERA_DISTANCE, cameraFov),
    }),
  });
  renderer.dispose();
});

test("observes and frames the prism relative to its canvas-local DOM slot", async () => {
  const env = browser();
  const live = gpu();
  mocks.init.mockResolvedValueOnce(live.instance);
  const renderer = createRenderer({
    canvas: env.canvas,
    framingElement: env.framingElement,
    initialMode: "dark",
  });
  await renderer.ready;
  const darkLight = drawNamed(live, "prism-rainbow.light");

  expect(env.observe).toHaveBeenCalledWith(env.canvas);
  expect(env.observe).toHaveBeenCalledWith(env.framingElement);
  expect(env.frames.size).toBe(1);
  [...env.frames.values()][0]?.(16);

  const tick = live.instance.fns.frameLoop.mock.calls[0]![0];
  tick(live.loopFrame);
  const uniforms = darkLight.set.mock.lastCall?.[0] as {
    scene: { viewProjection: Float32Array };
  };
  const matrix = uniforms.scene.viewProjection;
  // A canvas-local slot on the right produces an off-axis projection, while
  // the exact silhouette containment is covered by framing.test.ts.
  expect(matrix[12]! / matrix[15]!).toBeGreaterThan(0);
  expect(Number.isFinite(matrix[13]! / matrix[15]!)).toBe(true);

  renderer.dispose();
});

test("the camera follows the pointer without rebuilding an unchanged light", async () => {
  const env = browser();
  const live = gpu();
  mocks.init.mockResolvedValueOnce(live.instance);
  const renderer = createRenderer({ canvas: env.canvas, initialMode: "dark" });
  await renderer.ready;
  const tick = live.instance.fns.frameLoop.mock.calls[0]![0];
  const pointer = {
    pointerId: 7,
    clientX: 100,
    clientY: PRISM_DEFAULT_ARC * 100,
  } as unknown as Event;

  env.windowListeners.get("pointermove")?.(pointer);
  const writes = live.lightBuffer.write.mock.calls.length;
  tick(live.loopFrame);
  // Repeating the same pointer coordinate continues the camera easing without
  // regenerating the already-current world-space light mesh.
  env.windowListeners.get("pointermove")?.(pointer);
  expect(live.lightBuffer.write).toHaveBeenCalledTimes(writes);
  expect(live.loopFrame.pass).toHaveBeenCalledTimes(15);
  renderer.dispose();
});

test("mobile ignores pointer input and advances the automatic beam", async () => {
  const env = browser();
  let mobile = true;
  (
    window as unknown as { matchMedia: (query: string) => MediaQueryList }
  ).matchMedia = vi.fn(
    () =>
      ({
        get matches() {
          return mobile;
        },
      } as MediaQueryList)
  );
  const live = gpu();
  mocks.init.mockResolvedValueOnce(live.instance);
  const renderer = createRenderer({ canvas: env.canvas, initialMode: "dark" });
  await renderer.ready;
  const tick = live.instance.fns.frameLoop.mock.calls[0]![0];
  const writes = live.lightBuffer.write.mock.calls.length;

  env.windowListeners.get("pointermove")?.({
    isPrimary: true,
    clientX: 0,
    clientY: 100,
  } as unknown as Event);
  mobile = false;
  tick(live.loopFrame);
  expect(live.lightBuffer.write).toHaveBeenCalledTimes(writes);

  mobile = true;
  live.gpuClock.time = 0;
  tick(live.loopFrame);
  expect(live.lightBuffer.write).toHaveBeenCalledTimes(writes + 1);
  renderer.dispose();
});

test("pauses well offscreen and resumes once with the latest layout and controls", async () => {
  const env = browser();
  const live = gpu();
  mocks.init.mockResolvedValueOnce(live.instance);
  const renderer = createRenderer({ canvas: env.canvas, initialMode: "dark" });
  await renderer.ready;
  const darkLight = drawNamed(live, "prism-rainbow.light");
  env.flushAnimationFrames();

  expect(env.intersectionObserve).toHaveBeenCalledWith(env.canvas);
  expect(env.intersectionOptions).toEqual({
    rootMargin: "256px 0px",
    threshold: 0,
  });
  expect(env.documentListeners.has("visibilitychange")).toBe(true);
  expect(live.instance.fns.frameLoop).toHaveBeenCalledOnce();

  env.intersect(false);
  env.intersect(false);
  expect(live.stop).toHaveBeenCalledOnce();

  renderer.setControls?.({
    ...DEFAULT_PRISM_CONTROLS,
    view: "caustic",
    wallColor: "#102030",
  });
  env.setCanvasRect({ right: 320, bottom: 180, width: 320, height: 180 });
  env.resizeObserved();
  renderer.invalidate();
  expect(live.instance.fns.frameLoop).toHaveBeenCalledOnce();

  env.intersect(true);
  env.intersect(true);
  expect(live.instance.fns.frameLoop).toHaveBeenCalledTimes(2);
  env.flushAnimationFrames(32);
  expect(live.surface.resize).toHaveBeenLastCalledWith([640, 360]);

  const resumedTick = live.instance.fns.frameLoop.mock.calls[1]![0];
  resumedTick(live.loopFrame);
  expect(live.loopFrame.pass).toHaveBeenCalled();
  expect(darkLight.set).toHaveBeenLastCalledWith({
    scene: expect.objectContaining({
      wallColor: [16 / 255, 32 / 255, 48 / 255],
      causticOnly: 1,
    }),
  });

  env.intersect(false);
  expect(live.stop).toHaveBeenCalledTimes(2);
  renderer.dispose();
  expect(live.stop).toHaveBeenCalledTimes(2);
  expect(env.intersectionDisconnect).toHaveBeenCalledOnce();
  expect(env.documentListeners.has("visibilitychange")).toBe(false);
  expect(live.surface.dispose).toHaveBeenCalledOnce();
  expect(live.instance.dispose).toHaveBeenCalledOnce();
});

test("stays stopped when initialization finishes hidden and offscreen", async () => {
  const env = browser();
  env.setHidden(true);
  env.setCanvasRect({ top: 2_000, bottom: 2_100 });
  const live = gpu();
  const pending = deferred<typeof live.instance>();
  mocks.init.mockReturnValueOnce(pending.promise);
  const renderer = createRenderer({ canvas: env.canvas, initialMode: "dark" });
  pending.resolve(live.instance);
  await renderer.ready;

  expect(live.instance.fns.frameLoop).not.toHaveBeenCalled();
  env.setHidden(false, true);
  expect(live.instance.fns.frameLoop).not.toHaveBeenCalled();
  env.setCanvasRect({ top: 0, bottom: 100 });
  env.intersect(true);
  expect(live.instance.fns.frameLoop).toHaveBeenCalledOnce();

  renderer.dispose();
  expect(live.stop).toHaveBeenCalledOnce();
});

test.each([
  ["debug previews", { debugPreviews: true }, true],
  ["performance sampling", { performanceSampling: true }, false],
] as const)("%s bypass inactive scheduling", async (_label, optIn, observesActivity) => {
  const env = browser();
  env.setHidden(true);
  env.setCanvasRect({ top: 2_000, bottom: 2_100 });
  vi.stubGlobal("navigator", {});
  const live = gpu();
  mocks.init.mockResolvedValueOnce(live.instance);
  const renderer = createRenderer({
    canvas: env.canvas,
    initialMode: "dark",
    ...optIn,
  });
  await renderer.ready;

  expect(live.instance.fns.frameLoop).toHaveBeenCalledOnce();
  expect(env.intersectionObserve).toHaveBeenCalledTimes(
    observesActivity ? 1 : 0
  );
  expect(env.documentListeners.has("visibilitychange")).toBe(
    observesActivity
  );
  env.setHidden(false, true);
  env.intersect(false);
  expect(live.stop).not.toHaveBeenCalled();

  renderer.dispose();
  expect(live.stop).toHaveBeenCalledOnce();
});

test("coalesces resizes and updates both scene targets plus the light mesh", async () => {
  const env = browser();
  const live = gpu();
  mocks.init.mockResolvedValueOnce(live.instance);
  const renderer = createRenderer({ canvas: env.canvas, initialMode: "dark" });
  await renderer.ready;

  renderer.resize({ width: 300, height: 150, dpr: 1.6 });
  renderer.resize({ width: 900, height: 500, dpr: 2 });
  // Two requests, one animation frame: the last size wins.
  expect(env.frames.size).toBe(1);
  [...env.frames.values()][0]?.(16);
  expect(live.surface.resize).toHaveBeenCalledOnce();
  expect(live.surface.resize).toHaveBeenCalledWith([1800, 1000]);

  expect(live.targets[0]!.resize).toHaveBeenCalledWith([1800, 1000]);
  expect(live.targets[1]!.resize).toHaveBeenCalledWith([1800, 1000]);
  const bloomSizes = [
    [900, 500],
    [450, 250],
    [225, 125],
    [113, 63],
  ];
  live.targets.slice(2, 10).forEach((colorTarget, index) => {
    expect(colorTarget.resize).toHaveBeenCalledWith(
      bloomSizes[Math.floor(index / 2)]
    );
  });
  expect(live.targets[10]!.resize).toHaveBeenCalledWith([1800, 1000]);
  for (const transientTarget of live.targets.slice(11)) {
    expect(transientTarget.resize).not.toHaveBeenCalled();
    expect(transientTarget.destroy).toHaveBeenCalledOnce();
  }
  for (const colorTarget of live.targets.slice(0, 11))
    expect(colorTarget.destroy).not.toHaveBeenCalled();
  // Preparing at the runtime's existing size is a no-op; only the real resize
  // retraces the wall-bounded light mesh.
  expect(live.lightBuffer.write).toHaveBeenCalledTimes(2);

  renderer.dispose();
  renderer.dispose();
  expect(live.stop).toHaveBeenCalledOnce();
  expect(env.disconnect).toHaveBeenCalledOnce();
  expect(live.surface.dispose).toHaveBeenCalledOnce();
  expect(live.instance.dispose).toHaveBeenCalledOnce();
  expect(env.canvasListeners.size).toBe(0);
  expect(env.windowListeners.size).toBe(0);
  expect(live.lightBuffer.destroy).toHaveBeenCalledOnce();
  for (const colorTarget of live.targets)
    expect(colorTarget.destroy).toHaveBeenCalledOnce();
  for (const environmentTexture of live.textures)
    expect(environmentTexture.destroy).toHaveBeenCalledOnce();
});

test("a stale async theme switch cannot replace the latest active mode", async () => {
  const env = browser();
  const live = gpu();
  const assetFetch = deferred<Response>();
  vi.stubGlobal(
    "fetch",
    vi.fn(() => assetFetch.promise)
  );
  mocks.init.mockResolvedValueOnce(live.instance);
  const renderer = createRenderer({
    canvas: env.canvas,
    initialMode: "dark",
  });
  await renderer.ready;
  const debugBridge = renderer.debugBridge;

  const switchToLight = renderer.setMode("light");
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  const keepDark = renderer.setMode("dark");
  assetFetch.resolve({
    ok: false,
    status: 503,
    statusText: "offline",
  } as Response);
  await Promise.all([switchToLight, keepDark]);

  expect(renderer.debugSources()[0]?.id).toBe(PRISM_DARK_DEBUG_SOURCE_IDS[0]);
  expect(renderer.debugBridge).toBe(debugBridge);
  expect(live.targets[0]!.destroy).not.toHaveBeenCalled();
  expect(live.targets[1]!.destroy).not.toHaveBeenCalled();
  expect(
    live.targets
      .slice(-2)
      .every(({ destroy }) => destroy.mock.calls.length === 1)
  ).toBe(true);
  renderer.dispose();
});

test("a failed theme candidate preserves the active pipeline and can recover", async () => {
  const env = browser();
  const live = gpu();
  const onError = vi.fn();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Promise.reject(new Error("offline")))
  );
  mocks.init.mockResolvedValueOnce(live.instance);
  const renderer = createRenderer({
    canvas: env.canvas,
    initialMode: "dark",
    onError,
  });
  await renderer.ready;

  live.failNextCompile(new Error("light shader failed"));
  await expect(renderer.setMode("light")).rejects.toThrow(
    "light shader failed"
  );
  expect(renderer.debugSources()[0]?.id).toBe(PRISM_DARK_DEBUG_SOURCE_IDS[0]);
  expect(onError).toHaveBeenCalledWith(
    expect.objectContaining({ message: "light shader failed" })
  );
  expect(live.stop).not.toHaveBeenCalled();
  expect(live.surface.dispose).not.toHaveBeenCalled();
  expect(live.instance.dispose).not.toHaveBeenCalled();

  await renderer.setMode("light");
  expect(renderer.debugSources().at(-1)?.id).toBe("final-output");
  expect(live.stop).not.toHaveBeenCalled();
  renderer.dispose();
});

test("dispose defers shared GPU teardown until a pending mode prepare settles", async () => {
  const env = browser();
  const live = gpu();
  const assetFetch = deferred<Response>();
  vi.stubGlobal(
    "fetch",
    vi.fn(() => assetFetch.promise)
  );
  mocks.init.mockResolvedValueOnce(live.instance);
  const renderer = createRenderer({
    canvas: env.canvas,
    initialMode: "dark",
  });
  await renderer.ready;

  const switchToLight = renderer.setMode("light");
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  renderer.dispose();
  expect(live.stop).toHaveBeenCalledOnce();
  expect(live.surface.dispose).not.toHaveBeenCalled();
  expect(live.instance.dispose).not.toHaveBeenCalled();
  expect(live.lightBuffer.destroy).not.toHaveBeenCalled();

  assetFetch.resolve({
    ok: false,
    status: 503,
    statusText: "offline",
  } as Response);
  await switchToLight;
  await vi.waitFor(() => expect(live.instance.dispose).toHaveBeenCalledOnce());
  expect(live.surface.dispose).toHaveBeenCalledOnce();
  expect(live.lightBuffer.destroy).toHaveBeenCalledOnce();
  for (const colorTarget of live.targets)
    expect(colorTarget.destroy).toHaveBeenCalledOnce();
  for (const texture of live.textures)
    expect(texture.destroy).toHaveBeenCalledOnce();
});

test("dispose during init cleans up a late GPU without starting a loop", async () => {
  const env = browser();
  const pending = deferred<ReturnType<typeof gpu>["instance"]>();
  mocks.init.mockReturnValueOnce(pending.promise);
  const renderer = createRenderer({ canvas: env.canvas, initialMode: "dark" });
  await vi.waitFor(() => expect(mocks.init).toHaveBeenCalledOnce());
  renderer.dispose();
  const late = gpu();
  pending.resolve(late.instance);
  await renderer.ready;
  expect(late.instance.dispose).toHaveBeenCalledOnce();
  expect(late.instance.fns.frameLoop).not.toHaveBeenCalled();
});

test("reports an initialization failure once, rejects ready, and self-disposes", async () => {
  const env = browser();
  const failed = gpu();
  const error = new Error("surface failed");
  failed.instance.fns.surface.mockImplementationOnce(() => {
    throw error;
  });
  mocks.init.mockResolvedValueOnce(failed.instance);
  const onError = vi.fn(() => {
    throw new Error("reporter failed");
  });
  const renderer = createRenderer({
    canvas: env.canvas,
    initialMode: "dark",
    onError,
  });
  await expect(renderer.ready).rejects.toBe(error);
  expect(onError).toHaveBeenCalledOnce();
  expect(failed.instance.dispose).toHaveBeenCalledOnce();
  renderer.dispose();
  expect(failed.instance.dispose).toHaveBeenCalledOnce();
});
