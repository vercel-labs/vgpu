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
import { wallExtent } from "./scene";
import { DEFAULT_PRISM_CONTROLS, PRISM_LIGHT_PLANE_Z } from "./types";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function browser() {
  const windowListeners = new Map<string, EventListener>();
  const canvasListeners = new Map<string, EventListener>();
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  vi.stubGlobal("window", {
    devicePixelRatio: 2,
    addEventListener: vi.fn((name: string, listener: EventListener) =>
      windowListeners.set(name, listener)
    ),
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
  const canvas = {
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 200, height: 100 }),
    addEventListener: vi.fn((name: string, listener: EventListener) =>
      canvasListeners.set(name, listener)
    ),
    removeEventListener: vi.fn((name: string) => canvasListeners.delete(name)),
    setPointerCapture: vi.fn((id: number) => captured.add(id)),
    hasPointerCapture: vi.fn((id: number) => captured.has(id)),
    releasePointerCapture: vi.fn((id: number) => captured.delete(id)),
  } as unknown as HTMLCanvasElement;
  return { canvas, canvasListeners, windowListeners, frames, disconnect };
}

function gpu() {
  const stop = vi.fn();
  const encodedPasses: unknown[][] = [];
  const passOptions: unknown[] = [];
  const loopFrame = {
    pass: vi.fn((options: unknown, body: (pass: unknown) => void) => {
      passOptions.push(options);
      const encoded: unknown[] = [];
      body({ draw: (pipeline: unknown) => encoded.push(pipeline) });
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
    set: ReturnType<typeof vi.fn>;
    compile: ReturnType<typeof vi.fn>;
  }[] = [];
  const draws: {
    set: ReturnType<typeof vi.fn>;
    compile: ReturnType<typeof vi.fn>;
  }[] = [];
  const targets: {
    size: number[];
    format: string;
    resize: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
  }[] = [];
  const pipeline = (
    into: { set: ReturnType<typeof vi.fn>; compile: ReturnType<typeof vi.fn> }[]
  ) => {
    const created = { set: vi.fn(), compile: vi.fn(async () => {}) };
    into.push(created);
    return created;
  };
  const instance = {
    gpu: { queue: { onSubmittedWorkDone: vi.fn(async () => {}) } },
    device: { createBuffer: vi.fn(() => lightBuffer) },
    settled: vi.fn(async () => {}),
    dispose: vi.fn(),
    fns: {
      surface: vi.fn(() => surface),
      sampler: vi.fn(() => ({})),
      geometry: vi.fn(() => ({ destroy: vi.fn() })),
      target: vi.fn((options: { size: number[]; format?: string }) => {
        const created = {
          size: [...options.size],
          format: options.format ?? "bgra8unorm",
          resize: vi.fn((size: number[]) => {
            created.size = [...size];
          }),
          destroy: vi.fn(),
        };
        targets.push(created);
        return created;
      }),
      effect: vi.fn(() => pipeline(effects)),
      draw: vi.fn(() => pipeline(draws)),
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
    loopFrame,
    encodedPasses,
    passOptions,
    stop,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

test("renders the deterministic light once and idles until something changes", async () => {
  const env = browser();
  const live = gpu();
  mocks.init.mockResolvedValueOnce(live.instance);
  const renderer = createRenderer({ canvas: env.canvas });
  await renderer.ready;

  expect(live.instance.fns.frameLoop).toHaveBeenCalledOnce();
  // The light mesh is written once at construction and once after the final
  // output aspect is known. No history textures are allocated.
  expect(live.instance.device.createBuffer).toHaveBeenCalledOnce();
  expect(live.lightBuffer.write).toHaveBeenCalledTimes(2);
  expect(live.effects).toHaveLength(10);
  expect(live.draws).toHaveLength(6);
  for (const created of [...live.effects, ...live.draws])
    expect(created.compile).toHaveBeenCalledOnce();
  // Canvas surfaces do not expose a current texture until a frame begins, so
  // output pipelines must pre-warm from the surface's stable format signature.
  expect(live.effects[9]!.compile).toHaveBeenCalledWith({
    colors: ["bgra8unorm"],
  });
  // Two full-resolution targets resolve glass. Four progressively smaller HDR
  // targets hold the 1/2 through 1/16 bloom pyramid.
  expect(live.targets).toHaveLength(6);
  expect(live.targets[0]!.format).toBe("rgba16float");
  expect(live.targets[1]!.format).toBe("rgba16float");
  expect(live.targets.slice(2).map((entry) => entry.size)).toEqual([
    [100, 50],
    [50, 25],
    [25, 13],
    [13, 7],
  ]);
  for (const bloomTarget of live.targets.slice(2)) {
    expect(bloomTarget.format).toBe("rgba16float");
  }
  expect(live.effects[0]!.compile).toHaveBeenCalledWith(live.targets[1]);
  expect(live.effects[1]!.compile).toHaveBeenCalledWith(live.targets[0]);
  for (let level = 0; level < 4; level++) {
    expect(live.effects[level + 2]!.compile).toHaveBeenCalledWith(
      live.targets[level + 2]
    );
  }
  for (let index = 0; index < 3; index++) {
    expect(live.effects[index + 6]!.compile).toHaveBeenCalledWith(
      live.targets[4 - index]
    );
  }
  expect(live.draws[2]!.compile).toHaveBeenCalledWith(live.targets[1]);
  expect(live.draws[3]!.compile).toHaveBeenCalledWith(live.targets[0]);
  expect(live.draws[4]!.compile).toHaveBeenCalledWith(live.targets[0]);
  expect(live.draws[5]!.compile).toHaveBeenCalledWith(live.targets[0]);
  expect(live.effects[0]!.set).toHaveBeenLastCalledWith({
    sceneTexture: live.targets[0],
  });
  expect(live.draws[2]!.set).toHaveBeenLastCalledWith(
    expect.objectContaining({ sceneTexture: live.targets[0] })
  );
  expect(live.effects[1]!.set).toHaveBeenLastCalledWith({
    sceneTexture: live.targets[1],
  });
  expect(live.draws[3]!.set).toHaveBeenLastCalledWith(
    expect.objectContaining({ sceneTexture: live.targets[1] })
  );
  expect(live.effects[2]!.set).toHaveBeenLastCalledWith(
    expect.objectContaining({ sourceTexture: live.targets[0] })
  );
  expect(live.effects[3]!.set).toHaveBeenLastCalledWith(
    expect.objectContaining({ sourceTexture: live.targets[2] })
  );
  expect(live.effects[6]!.set).toHaveBeenLastCalledWith(
    expect.objectContaining({ sourceTexture: live.targets[5] })
  );
  expect(live.effects[7]!.set).toHaveBeenLastCalledWith(
    expect.objectContaining({ sourceTexture: live.targets[4] })
  );
  expect(live.effects[8]!.set).toHaveBeenLastCalledWith(
    expect.objectContaining({ sourceTexture: live.targets[3] })
  );
  expect(live.effects[9]!.set).toHaveBeenLastCalledWith(
    expect.objectContaining({
      sceneTexture: live.targets[0],
      bloomTexture: live.targets[2],
    })
  );
  expect(live.draws[0]!.set).toHaveBeenLastCalledWith({
    scene: expect.objectContaining({ lightPlaneZ: PRISM_LIGHT_PLANE_Z }),
  });

  const tick = live.instance.fns.frameLoop.mock.calls[0]![0];
  tick(live.loopFrame);
  // frameLoop already owns the frame: all eleven passes encode into the supplied
  // frame instead of opening nested frames.
  expect(live.instance.fns.frame).not.toHaveBeenCalled();
  expect(live.loopFrame.pass).toHaveBeenCalledTimes(11);
  expect(live.encodedPasses).toEqual([
    [live.draws[1]],
    [live.effects[0], live.draws[2], live.draws[0]],
    [live.effects[1], live.draws[3]],
    [live.effects[2]],
    [live.effects[3]],
    [live.effects[4]],
    [live.effects[5]],
    [live.effects[6]],
    [live.effects[7]],
    [live.effects[8]],
    [live.effects[9]],
  ]);
  for (const options of live.passOptions.slice(7, 10)) {
    expect(options).toEqual(expect.objectContaining({ clear: false }));
  }
  tick(live.loopFrame);
  expect(live.loopFrame.pass).toHaveBeenCalledTimes(11);
  renderer.dispose();
});

test("the back-face view presents the second target before the front interface", async () => {
  const env = browser();
  const live = gpu();
  mocks.init.mockResolvedValueOnce(live.instance);
  const renderer = createRenderer({ canvas: env.canvas });
  await renderer.ready;
  const tick = live.instance.fns.frameLoop.mock.calls[0]![0];

  renderer.setControls?.({ ...DEFAULT_PRISM_CONTROLS, view: "back" });
  tick(live.loopFrame);

  expect(live.encodedPasses).toEqual([
    [live.draws[1]],
    [live.effects[0], live.draws[2], live.draws[0]],
    [live.effects[1]],
    [live.effects[2]],
    [live.effects[3]],
    [live.effects[4]],
    [live.effects[5]],
    [live.effects[6]],
    [live.effects[7]],
    [live.effects[8]],
    [live.effects[9]],
  ]);
  renderer.dispose();
});

test("the light wireframe reveals every generated triangle in the light-only view", async () => {
  const env = browser();
  const live = gpu();
  mocks.init.mockResolvedValueOnce(live.instance);
  const renderer = createRenderer({ canvas: env.canvas });
  await renderer.ready;
  const tick = live.instance.fns.frameLoop.mock.calls[0]![0];

  renderer.setControls?.({
    ...DEFAULT_PRISM_CONTROLS,
    view: "caustic",
    lightWireframe: true,
  });
  tick(live.loopFrame);

  expect(live.encodedPasses[0]).toEqual([
    live.draws[1],
    live.draws[0],
    live.draws[5],
  ]);
  expect(live.draws[5]!.set).toHaveBeenLastCalledWith({
    scene: expect.objectContaining({ lightPlaneZ: PRISM_LIGHT_PLANE_Z }),
  });
  renderer.dispose();
});

test("a pointer drag swings the lamp and rewrites the deterministic mesh", async () => {
  const env = browser();
  const live = gpu();
  mocks.init.mockResolvedValueOnce(live.instance);
  const renderer = createRenderer({ canvas: env.canvas });
  await renderer.ready;
  const writesBeforeDrag = live.lightBuffer.write.mock.calls.length;

  env.canvasListeners.get("pointerdown")?.({
    isPrimary: true,
    pointerId: 4,
    clientY: 10,
  } as unknown as Event);
  expect(env.canvas.setPointerCapture).toHaveBeenCalledWith(4);
  expect(live.lightBuffer.write).toHaveBeenCalledTimes(writesBeforeDrag + 1);

  env.canvasListeners.get("pointermove")?.({
    pointerId: 4,
    clientY: 90,
  } as unknown as Event);
  expect(live.lightBuffer.write).toHaveBeenCalledTimes(writesBeforeDrag + 2);
  // A move from a pointer we never captured is ignored.
  env.canvasListeners.get("pointermove")?.({
    pointerId: 9,
    clientY: 20,
  } as unknown as Event);
  expect(live.lightBuffer.write).toHaveBeenCalledTimes(writesBeforeDrag + 2);

  env.canvasListeners.get("pointerup")?.({ pointerId: 4 } as unknown as Event);
  expect(env.canvas.releasePointerCapture).toHaveBeenCalledWith(4);
  renderer.dispose();
});

test("only optical controls rebuild the light mesh", async () => {
  const env = browser();
  const live = gpu();
  mocks.init.mockResolvedValueOnce(live.instance);
  const renderer = createRenderer({ canvas: env.canvas });
  await renderer.ready;
  const tick = live.instance.fns.frameLoop.mock.calls[0]![0];
  const writes = live.lightBuffer.write.mock.calls.length;

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
  // The optional mirror ball is a separate renderer and cannot retrace light.
  renderer.setControls?.({
    ...DEFAULT_PRISM_CONTROLS,
    environmentDebug: true,
  });
  expect(live.lightBuffer.write).toHaveBeenCalledTimes(writes);
  // Glass material sliders update uniforms without retracing the spectral mesh.
  renderer.setControls?.({
    ...DEFAULT_PRISM_CONTROLS,
    glass: {
      ...DEFAULT_PRISM_CONTROLS.glass,
      ior: 1.72,
      absorption: [0.2, 0.15, 0.1],
    },
  });
  tick(live.loopFrame);
  expect(live.lightBuffer.write).toHaveBeenCalledTimes(writes);
  expect(live.draws[2]!.set).toHaveBeenLastCalledWith(
    expect.objectContaining({
      params: expect.objectContaining({
        ior: 1.72,
        absorption: [0.2, 0.15, 0.1],
      }),
    })
  );
  // Bloom runs on the already-rendered HDR image; its controls only update
  // postprocess uniforms and leave the traced light mesh untouched.
  renderer.setControls?.({
    ...DEFAULT_PRISM_CONTROLS,
    postprocess: {
      bloomStrength: 1.8,
      bloomThreshold: 0.4,
      bloomRadius: 4,
    },
  });
  tick(live.loopFrame);
  expect(live.lightBuffer.write).toHaveBeenCalledTimes(writes);
  expect(live.effects[2]!.set).toHaveBeenLastCalledWith(
    expect.objectContaining({
      params: expect.objectContaining({
        threshold: 0.4,
        extractHighlights: 1,
      }),
    })
  );
  expect(live.effects[9]!.set).toHaveBeenLastCalledWith(
    expect.objectContaining({
      params: { bloomStrength: 1.8 },
    })
  );
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
  renderer.dispose();
});

test("fade controls rebuild only the data that cannot stay in the shader", async () => {
  const env = browser();
  const live = gpu();
  mocks.init.mockResolvedValueOnce(live.instance);
  const renderer = createRenderer({ canvas: env.canvas });
  await renderer.ready;
  const tick = live.instance.fns.frameLoop.mock.calls[0]![0];
  const writes = live.lightBuffer.write.mock.calls.length;

  renderer.setControls?.({
    ...DEFAULT_PRISM_CONTROLS,
    lightFade: { edgeFalloff: 10, rainbowFalloff: 3.2 },
  });
  expect(live.lightBuffer.write).toHaveBeenCalledTimes(writes + 1);

  renderer.setControls?.({
    ...DEFAULT_PRISM_CONTROLS,
    lightFade: { edgeFalloff: 10, rainbowFalloff: 5.5 },
  });
  expect(live.lightBuffer.write).toHaveBeenCalledTimes(writes + 1);
  tick(live.loopFrame);
  expect(live.draws[0]!.set).toHaveBeenLastCalledWith({
    scene: expect.objectContaining({
      lightEdgeFalloff: 10,
      rainbowFalloff: 5.5,
    }),
  });
  renderer.dispose();
});

test("camera controls update the framing and its derived wall boundary", async () => {
  const env = browser();
  const live = gpu();
  mocks.init.mockResolvedValueOnce(live.instance);
  const renderer = createRenderer({ canvas: env.canvas });
  await renderer.ready;
  const tick = live.instance.fns.frameLoop.mock.calls[0]![0];
  const writes = live.lightBuffer.write.mock.calls.length;
  const cameraDistance = 3.2;
  const cameraFov = 56;

  renderer.setControls?.({
    ...DEFAULT_PRISM_CONTROLS,
    cameraDistance,
    cameraFov,
  });
  expect(live.lightBuffer.write).toHaveBeenCalledTimes(writes + 1);
  tick(live.loopFrame);
  expect(live.draws[1]!.set).toHaveBeenLastCalledWith({
    scene: expect.objectContaining({
      wallHalfExtent: wallExtent(2, cameraDistance, cameraFov),
    }),
  });
  renderer.dispose();
});

test("the camera follows the pointer without rebuilding world-space light", async () => {
  const env = browser();
  const live = gpu();
  mocks.init.mockResolvedValueOnce(live.instance);
  const renderer = createRenderer({ canvas: env.canvas });
  await renderer.ready;
  const tick = live.instance.fns.frameLoop.mock.calls[0]![0];
  const writes = live.lightBuffer.write.mock.calls.length;

  // Hovering — no capture, no drag — moves only the camera matrix.
  env.canvasListeners.get("pointermove")?.({
    pointerId: 7,
    clientX: 180,
    clientY: 20,
  } as unknown as Event);
  tick(live.loopFrame);
  expect(live.lightBuffer.write).toHaveBeenCalledTimes(writes);
  expect(live.loopFrame.pass).toHaveBeenCalledTimes(11);
  renderer.dispose();
});

test("coalesces resizes and updates both targets plus the light mesh", async () => {
  const env = browser();
  const live = gpu();
  mocks.init.mockResolvedValueOnce(live.instance);
  const renderer = createRenderer({ canvas: env.canvas });
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
  live.targets.slice(2).forEach((colorTarget, level) => {
    expect(colorTarget.resize).toHaveBeenCalledWith(bloomSizes[level]);
  });
  for (const colorTarget of live.targets)
    expect(colorTarget.destroy).not.toHaveBeenCalled();
  expect(live.lightBuffer.write).toHaveBeenCalledTimes(3);

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
});

test("dispose during init cleans up a late GPU without starting a loop", async () => {
  const env = browser();
  const pending = deferred<ReturnType<typeof gpu>["instance"]>();
  mocks.init.mockReturnValueOnce(pending.promise);
  const renderer = createRenderer({ canvas: env.canvas });
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
  const renderer = createRenderer({ canvas: env.canvas, onError });
  await expect(renderer.ready).rejects.toBe(error);
  expect(onError).toHaveBeenCalledOnce();
  expect(failed.instance.dispose).toHaveBeenCalledOnce();
  renderer.dispose();
  expect(failed.instance.dispose).toHaveBeenCalledOnce();
});
