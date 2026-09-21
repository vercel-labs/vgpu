import { afterEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  init: vi.fn(),
  rasterizeLogo: vi.fn(),
}));

vi.mock("vgpu", () => ({
  init: mocks.init,
  surface: (gpu: any, canvas: any, options: any) =>
    gpu.surface(canvas, options),
  sampler: (gpu: any, options: any) => gpu.sampler(options),
  effect: (gpu: any, shader: any, options: any) => gpu.effect(shader, options),
  target: (gpu: any, options: any) => gpu.target(options),
  frame: (gpu: any, callback: any) => gpu.frame(callback),
}));

vi.mock("./logo-raster", () => ({
  rasterizeLogo: mocks.rasterizeLogo,
}));

vi.mock("./logo-raster-baked", () => ({
  BAKED_LOGO_WIDTH: 2,
  BAKED_LOGO_HEIGHT: 2,
  bakedLogoRgba: vi.fn(async () => new Uint8Array(16)),
}));

import { renderThumbnail } from "./render-thumbnail";
import { createRenderer } from "./renderer";
import {
  centeredPlacement,
  FlarePipeline,
  followLight,
  mapAutonomousLight,
  type LogoRaster,
} from "./pipeline";

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function setup() {
  const state: {
    compile?: (label: string) => Promise<void> | void;
    set?: (label: string, values: unknown) => void;
    failTargetAt?: number;
    targetError?: unknown;
    failTextureAt?: number;
    textureError?: unknown;
    uploadError?: unknown;
    frameError?: unknown;
    failEffectAt?: number;
    effectError?: unknown;
    destroy?: (kind: string, index: number) => void;
  } = {};
  const events: string[] = [];
  const canvasListeners = new Map<string, EventListener>();
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  vi.stubGlobal("window", { devicePixelRatio: 2 });
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn((callback: FrameRequestCallback) => {
      const id = ++nextFrame;
      frames.set(id, callback);
      return id;
    })
  );
  const cancelFrame = vi.fn((id: number) => frames.delete(id));
  vi.stubGlobal("cancelAnimationFrame", cancelFrame);
  const disconnect = vi.fn();
  const observe = vi.fn();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe = observe;
      disconnect = disconnect;
    }
  );

  const rect = { left: 0, top: 0, width: 200, height: 100 };
  const canvas = {
    getBoundingClientRect: vi.fn(() => ({ ...rect })),
    addEventListener: vi.fn((name: string, listener: EventListener) => {
      canvasListeners.set(name, listener);
    }),
    removeEventListener: vi.fn((name: string) => canvasListeners.delete(name)),
  } as unknown as HTMLCanvasElement;

  const textures: Array<{
    readonly label: string;
    readonly destroy: ReturnType<typeof vi.fn>;
  }> = [];
  const targets: Array<{
    readonly color: { readonly destroy: ReturnType<typeof vi.fn> };
    readonly resize: ReturnType<typeof vi.fn>;
    readonly format: string;
    readonly sampleCount: 1;
    readonly size: readonly [number, number];
  }> = [];
  const effects: Array<{
    readonly label: string;
    readonly set: ReturnType<typeof vi.fn>;
    readonly compile: ReturnType<typeof vi.fn>;
  }> = [];

  let surfaceSize: [number, number] = [200, 100];
  const surface = {
    get size() {
      return surfaceSize;
    },
    resize: vi.fn((size: readonly [number, number]) => {
      surfaceSize = [...size];
    }),
    dispose: vi.fn(),
    format: "bgra8unorm",
    sampleCount: 1 as const,
  };
  const framePass = vi.fn(() => events.push("pass"));
  const gpu = {
    gpu: {
      createTexture: vi.fn((descriptor: { label?: string }) => {
        const call = textures.length + 1;
        if (state.failTextureAt === call) throw state.textureError;
        const label = descriptor.label ?? `texture-${call}`;
        const texture = {
          label,
          destroy: vi.fn(() => {
            events.push(`destroy:${label}`);
            state.destroy?.(label, call);
          }),
        };
        textures.push(texture);
        return texture;
      }),
      queue: {
        writeTexture: vi.fn(() => {
          if (state.uploadError) throw state.uploadError;
        }),
        copyExternalImageToTexture: vi.fn(() => {
          if (state.uploadError) throw state.uploadError;
        }),
        onSubmittedWorkDone: vi.fn(async () => {
          events.push("queue");
        }),
      },
    },
    sampler: vi.fn(() => ({})),
    effect: vi.fn((_shader: unknown, options: { label?: string } = {}) => {
      const call = effects.length + 1;
      if (state.failEffectAt === call) throw state.effectError;
      const label = options.label ?? `effect-${effects.length}`;
      const value = {
        label,
        set: vi.fn((bindings: unknown) => {
          events.push(`set:${label}`);
          state.set?.(label, bindings);
        }),
        compile: vi.fn(() => state.compile?.(label) ?? Promise.resolve()),
      };
      effects.push(value);
      return value;
    }),
    target: vi.fn((options: { size: readonly [number, number] }) => {
      const call = targets.length + 1;
      if (state.failTargetAt === call) throw state.targetError;
      let size = [...options.size] as [number, number];
      const color = {
        destroy: vi.fn(() => {
          events.push(`destroy:target-${call}`);
          state.destroy?.("target", call);
        }),
      };
      const value = {
        color,
        get size() {
          return size;
        },
        resize: vi.fn((next: readonly [number, number]) => {
          size = [...next];
        }),
        format: "rgba8unorm",
        sampleCount: 1 as const,
      };
      targets.push(value);
      return value;
    }),
    surface: vi.fn(() => surface),
    frame: vi.fn((callback: (current: { pass: typeof framePass }) => void) => {
      if (state.frameError) throw state.frameError;
      callback({ pass: framePass });
    }),
    settled: vi.fn(async () => {
      events.push("settled");
    }),
    dispose: vi.fn(() => events.push("gpu:dispose")),
  };

  mocks.init.mockReset().mockResolvedValue(gpu);
  mocks.rasterizeLogo
    .mockReset()
    .mockResolvedValue({ width: 130, height: 156 });

  const runFrame = (now: number) => {
    const entry = [...frames.entries()].sort(([a], [b]) => a - b)[0];
    if (!entry) throw new Error("No animation frame is pending.");
    frames.delete(entry[0]);
    entry[1](now);
  };

  return {
    state,
    events,
    canvas,
    canvasListeners,
    frames,
    rect,
    cancelFrame,
    disconnect,
    observe,
    textures,
    targets,
    effects,
    surface,
    framePass,
    gpu,
    runFrame,
  };
}

function raster(upload?: LogoRaster["upload"]): LogoRaster {
  return {
    width: 32,
    height: 40,
    upload: upload ?? (() => {}),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("browser renderer", () => {
  test("maps autonomous, touch, pointer, leave, pulse, and frame progression", async () => {
    const env = setup();
    const renderer = createRenderer({ canvas: env.canvas });
    await renderer.ready;
    const rim = env.effects.find(
      (value) => value.label === "nextjs-flare-rim"
    )!;
    const composite = env.effects.find(
      (value) => value.label === "nextjs-flare-composite"
    )!;
    const placement = centeredPlacement(350, 175, 175);
    const touch = env.canvasListeners.get("pointermove")!;
    touch({ pointerType: "touch", clientX: 190, clientY: 90 } as PointerEvent);

    env.runFrame(100);
    let expected = followLight(
      placement.logoCenter,
      mapAutonomousLight(0.1, placement),
      0.05
    );
    expect(rim.set.mock.lastCall?.[0].params.light).toEqual(expected);
    expect(composite.set.mock.lastCall?.[0].params.frameIndex).toBe(0);
    expect(composite.set.mock.lastCall?.[0].params.rimIntensity).toBe(1);
    expect(env.framePass).toHaveBeenCalledTimes(5);

    touch({ pointerType: "mouse", clientX: 150, clientY: 25 } as PointerEvent);
    env.runFrame(200);
    expected = followLight(expected, [0.75, 0.25], 0.05);
    expect(rim.set.mock.lastCall?.[0].params.light).toEqual(expected);
    expect(composite.set.mock.lastCall?.[0].params.frameIndex).toBe(1);
    expect(env.framePass).toHaveBeenCalledTimes(9);

    env.canvasListeners.get("pointerleave")!(new Event("pointerleave"));
    env.runFrame(300);
    expected = followLight(expected, mapAutonomousLight(0.3, placement), 0.05);
    expect(rim.set.mock.lastCall?.[0].params.light).toEqual(expected);
    expect(composite.set.mock.lastCall?.[0].params.frameIndex).toBe(2);
    renderer.dispose();
  });

  test("uses gpu ownership and tears browser resources down once", async () => {
    const env = setup();
    const renderer = createRenderer({ canvas: env.canvas });
    await renderer.ready;
    renderer.dispose();
    renderer.dispose();

    expect(env.cancelFrame).toHaveBeenCalledOnce();
    expect(env.disconnect).toHaveBeenCalledOnce();
    expect(env.canvasListeners.size).toBe(0);
    expect(env.gpu.dispose).toHaveBeenCalledOnce();
    expect(env.surface.dispose).not.toHaveBeenCalled();
    for (const texture of env.textures)
      expect(texture.destroy).not.toHaveBeenCalled();
    for (const target of env.targets)
      expect(target.color.destroy).not.toHaveBeenCalled();
  });

  test("quietly releases a gpu that resolves after disposal", async () => {
    const env = setup();
    const pending = deferred<typeof env.gpu>();
    mocks.init.mockReset().mockReturnValue(pending.promise);
    const renderer = createRenderer({ canvas: env.canvas });
    await vi.waitFor(() => expect(mocks.init).toHaveBeenCalledOnce());
    renderer.dispose();
    pending.resolve(env.gpu);
    await renderer.ready;
    expect(env.gpu.dispose).toHaveBeenCalledOnce();
    expect(env.gpu.surface).not.toHaveBeenCalled();
  });

  test("preserves initialization and surface failures exactly", async () => {
    const env = setup();
    const initError = new Error("init failed");
    mocks.init.mockReset().mockRejectedValue(initError);
    const failedInit = createRenderer({ canvas: env.canvas });
    await expect(failedInit.ready).rejects.toBe(initError);

    const surfaceError = new Error("surface failed");
    mocks.init.mockReset().mockResolvedValue(env.gpu);
    env.gpu.surface.mockImplementationOnce(() => {
      throw surfaceError;
    });
    const failedSurface = createRenderer({ canvas: env.canvas });
    await expect(failedSurface.ready).rejects.toBe(surfaceError);
    expect(env.gpu.dispose).toHaveBeenCalledOnce();
  });

  test("cleans partial initial targets and rejects their exact construction error", async () => {
    const env = setup();
    const primary = new Error("target failed");
    env.state.failTargetAt = 3;
    env.state.targetError = primary;
    const renderer = createRenderer({ canvas: env.canvas });
    await expect(renderer.ready).rejects.toBe(primary);
    expect(env.targets).toHaveLength(2);
    for (const target of env.targets) {
      expect(target.color.destroy).toHaveBeenCalledOnce();
    }
    expect(env.gpu.dispose).toHaveBeenCalledOnce();
  });

  test("aborts stale rasters and commits only the coalesced resize", async () => {
    const env = setup();
    const renderer = createRenderer({ canvas: env.canvas });
    await renderer.ready;
    const first = deferred<HTMLCanvasElement>();
    const second = deferred<HTMLCanvasElement>();
    const signals: AbortSignal[] = [];
    mocks.rasterizeLogo.mockReset();
    mocks.rasterizeLogo
      .mockImplementationOnce((_size, signal: AbortSignal) => {
        signals.push(signal);
        return first.promise;
      })
      .mockImplementationOnce((_size, signal: AbortSignal) => {
        signals.push(signal);
        return second.promise;
      });

    const resizeA = renderer.resize({ width: 300, height: 150, dpr: 1.6 });
    await vi.waitFor(() =>
      expect(mocks.rasterizeLogo).toHaveBeenCalledTimes(1)
    );
    const resizeB = renderer.resize({ width: 400, height: 200, dpr: 1.6 });
    expect(signals[0]?.aborted).toBe(true);
    first.resolve({ width: 200, height: 240 } as HTMLCanvasElement);
    await vi.waitFor(() =>
      expect(mocks.rasterizeLogo).toHaveBeenCalledTimes(2)
    );
    second.resolve({ width: 210, height: 250 } as HTMLCanvasElement);
    await Promise.all([resizeA, resizeB]);

    expect(env.targets).toHaveLength(8);
    for (const target of env.targets.slice(0, 4)) {
      expect(target.color.destroy).toHaveBeenCalledOnce();
    }
    for (const target of env.targets.slice(4)) {
      expect(target.color.destroy).not.toHaveBeenCalled();
    }
    expect(env.surface.size).toEqual([640, 320]);
    const calls = mocks.rasterizeLogo.mock.calls.length;
    await renderer.resize({ width: 400, height: 200, dpr: 1.6 });
    expect(mocks.rasterizeLogo).toHaveBeenCalledTimes(calls);
    renderer.dispose();
  });

  test("quietly cleans a compile candidate that rejects after disposal", async () => {
    const env = setup();
    const compile = deferred<void>();
    env.state.compile = (label) =>
      label === "nextjs-flare-logo" ? compile.promise : undefined;
    const renderer = createRenderer({ canvas: env.canvas });
    await vi.waitFor(() =>
      expect(
        env.effects.find((value) => value.label === "nextjs-flare-logo")
          ?.compile
      ).toHaveBeenCalledOnce()
    );
    renderer.dispose();
    compile.reject(new Error("gpu was disposed"));
    await expect(renderer.ready).resolves.toBeUndefined();
    for (const target of env.targets) {
      expect(target.color.destroy).toHaveBeenCalledOnce();
    }
    expect(env.textures.at(-1)?.destroy).toHaveBeenCalledOnce();
    expect(env.gpu.dispose).toHaveBeenCalledOnce();
  });

  test("tears down and rejects a live raster failure with the primary identity", async () => {
    const env = setup();
    const renderer = createRenderer({ canvas: env.canvas });
    await renderer.ready;
    const primary = new Error("raster failed");
    mocks.rasterizeLogo.mockRejectedValueOnce(primary);
    env.gpu.dispose.mockImplementationOnce(() => {
      throw new Error("cleanup failed");
    });

    await expect(
      renderer.resize({ width: 300, height: 150, dpr: 1.6 })
    ).rejects.toBe(primary);
    expect(env.gpu.dispose).toHaveBeenCalledOnce();
    expect(env.canvasListeners.size).toBe(0);
    expect(env.disconnect).toHaveBeenCalledOnce();
  });

  test("cleans a failed upload candidate and keeps the exact error", async () => {
    const env = setup();
    const renderer = createRenderer({ canvas: env.canvas });
    await renderer.ready;
    const primary = new Error("upload failed");
    env.state.uploadError = primary;

    await expect(
      renderer.resize({ width: 300, height: 150, dpr: 1.6 })
    ).rejects.toBe(primary);
    expect(env.targets).toHaveLength(8);
    for (const target of env.targets.slice(0, 4)) {
      expect(target.color.destroy).not.toHaveBeenCalled();
    }
    for (const target of env.targets.slice(4)) {
      expect(target.color.destroy).toHaveBeenCalledOnce();
    }
    expect(env.textures.at(-1)?.destroy).toHaveBeenCalledOnce();
    expect(env.gpu.dispose).toHaveBeenCalledOnce();
  });

  test("tears down and rethrows a live frame failure", async () => {
    const env = setup();
    const renderer = createRenderer({ canvas: env.canvas });
    await renderer.ready;
    const primary = new Error("frame failed");
    env.state.frameError = primary;
    expect(() => env.runFrame(100)).toThrow(primary);
    expect(env.gpu.dispose).toHaveBeenCalledOnce();
    expect(env.canvasListeners.size).toBe(0);
  });
});

describe("transactional pipeline", () => {
  test("cleans every target allocated before partial target construction fails", async () => {
    const env = setup();
    const pipeline = new FlarePipeline(env.gpu as never, env.surface as never);
    const primary = new Error("third target failed");
    env.state.failTargetAt = 3;
    env.state.targetError = primary;
    await expect(pipeline.replace([320, 180], 2, raster())).rejects.toBe(
      primary
    );
    expect(env.targets).toHaveLength(2);
    for (const target of env.targets)
      expect(target.color.destroy).toHaveBeenCalledOnce();
    pipeline.dispose();
  });

  test("cleans targets and texture when upload fails", async () => {
    const uploadEnv = setup();
    const uploadPipeline = new FlarePipeline(
      uploadEnv.gpu as never,
      uploadEnv.surface as never
    );
    const uploadError = new Error("upload failed");
    await expect(
      uploadPipeline.replace(
        [320, 180],
        2,
        raster(() => {
          throw uploadError;
        })
      )
    ).rejects.toBe(uploadError);
    for (const target of uploadEnv.targets) {
      expect(target.color.destroy).toHaveBeenCalledOnce();
    }
    expect(uploadEnv.textures.at(-1)?.destroy).toHaveBeenCalledOnce();
    uploadPipeline.dispose();
  });

  test("waits for every compile before cleaning a failed candidate", async () => {
    const env = setup();
    const pipeline = new FlarePipeline(env.gpu as never, env.surface as never);
    const pending = deferred<void>();
    const primary = new Error("rim compile failed");
    env.state.compile = (label) => {
      if (label === "nextjs-flare-logo") return pending.promise;
      if (label === "nextjs-flare-rim") return Promise.reject(primary);
    };

    const replacement = pipeline.replace([320, 180], 2, raster());
    await vi.waitFor(() =>
      expect(
        env.effects.every((effect) => effect.compile.mock.calls.length === 1)
      ).toBe(true)
    );
    for (const target of env.targets) {
      expect(target.color.destroy).not.toHaveBeenCalled();
    }
    expect(env.textures.at(-1)?.destroy).not.toHaveBeenCalled();

    pending.resolve();
    await expect(replacement).rejects.toBe(primary);
    for (const target of env.targets) {
      expect(target.color.destroy).toHaveBeenCalledOnce();
    }
    expect(env.textures.at(-1)?.destroy).toHaveBeenCalledOnce();
    pipeline.dispose();
  });

  test("attempts every compile after synchronous throws and keeps the first error", async () => {
    const env = setup();
    const pipeline = new FlarePipeline(env.gpu as never, env.surface as never);
    const primary = new Error("rim compile failed synchronously");
    const secondary = new Error("composite compile also failed");
    env.state.compile = (label) => {
      if (label === "nextjs-flare-rim") throw primary;
      if (label === "nextjs-flare-composite") throw secondary;
    };

    await expect(pipeline.replace([320, 180], 2, raster())).rejects.toBe(
      primary
    );
    for (const effect of env.effects)
      expect(effect.compile).toHaveBeenCalledOnce();
    for (const target of env.targets) {
      expect(target.color.destroy).toHaveBeenCalledOnce();
    }
    expect(env.textures.at(-1)?.destroy).toHaveBeenCalledOnce();
    pipeline.dispose();
  });

  test("cleans candidate targets when logo texture creation fails", async () => {
    const env = setup();
    const pipeline = new FlarePipeline(env.gpu as never, env.surface as never);
    const primary = new Error("logo texture failed");
    env.state.failTextureAt = 2;
    env.state.textureError = primary;
    await expect(pipeline.replace([320, 180], 2, raster())).rejects.toBe(
      primary
    );
    for (const target of env.targets) {
      expect(target.color.destroy).toHaveBeenCalledOnce();
    }
    expect(env.textures).toHaveLength(1);
    pipeline.dispose();
  });

  test("rolls output and bindings back when candidate binding fails", async () => {
    const env = setup();
    const pipeline = new FlarePipeline(env.gpu as never, env.surface as never);
    await pipeline.replace([320, 180], 2, raster());
    const oldTargets = env.targets.slice();
    const oldLogo = env.textures.at(-1)!;
    const primary = new Error("bind failed");
    let shouldFail = true;
    env.state.set = (label) => {
      if (shouldFail && label === "nextjs-flare-rim-vertical") {
        shouldFail = false;
        throw primary;
      }
    };

    await expect(pipeline.replace([640, 360], 1, raster())).rejects.toBe(
      primary
    );
    expect(env.surface.size).toEqual([320, 180]);
    for (const target of oldTargets)
      expect(target.color.destroy).not.toHaveBeenCalled();
    for (const target of env.targets.slice(4)) {
      expect(target.color.destroy).toHaveBeenCalledOnce();
    }
    expect(oldLogo.destroy).not.toHaveBeenCalled();
    expect(env.textures.at(-1)?.destroy).toHaveBeenCalledOnce();
    pipeline.dispose();
  });

  test("discards stale and disposed compile candidates without a commit", async () => {
    const staleEnv = setup();
    const stalePipeline = new FlarePipeline(
      staleEnv.gpu as never,
      staleEnv.surface as never
    );
    const result = await stalePipeline.replace(
      [320, 180],
      2,
      raster(),
      () => true
    );
    expect(result).toBeUndefined();
    expect(staleEnv.surface.resize).not.toHaveBeenCalled();
    for (const target of staleEnv.targets) {
      expect(target.color.destroy).toHaveBeenCalledOnce();
    }
    expect(staleEnv.textures.at(-1)?.destroy).toHaveBeenCalledOnce();
    stalePipeline.dispose();

    const pendingEnv = setup();
    const compile = deferred<void>();
    pendingEnv.state.compile = (label) =>
      label === "nextjs-flare-logo" ? compile.promise : undefined;
    const pendingPipeline = new FlarePipeline(
      pendingEnv.gpu as never,
      pendingEnv.surface as never
    );
    const replacement = pendingPipeline.replace([320, 180], 2, raster());
    await vi.waitFor(() =>
      expect(
        pendingEnv.effects.find((value) => value.label === "nextjs-flare-logo")
          ?.compile
      ).toHaveBeenCalledOnce()
    );
    pendingPipeline.dispose();
    compile.resolve();
    await expect(replacement).resolves.toBeUndefined();
    for (const target of pendingEnv.targets) {
      expect(target.color.destroy).toHaveBeenCalledOnce();
    }
    expect(pendingEnv.textures.at(-1)?.destroy).toHaveBeenCalledOnce();
  });

  test("best-effort disposal is idempotent and preserves its first cleanup error", async () => {
    const env = setup();
    const pipeline = new FlarePipeline(env.gpu as never, env.surface as never);
    await pipeline.replace([320, 180], 2, raster());
    const primary = new Error("blue noise destroy failed");
    env.state.destroy = (kind) => {
      if (kind === "nextjs-flare-blue-noise-128") throw primary;
    };
    expect(() => pipeline.dispose()).toThrow(primary);
    for (const texture of env.textures)
      expect(texture.destroy).toHaveBeenCalledOnce();
    for (const target of env.targets)
      expect(target.color.destroy).toHaveBeenCalledOnce();
    expect(() => pipeline.dispose()).not.toThrow();
  });
});

describe("shared-gpu thumbnail", () => {
  test("waits for both barriers before releasing children and retains the gpu", async () => {
    const env = setup();
    const queue = deferred<void>();
    const settled = deferred<void>();
    env.gpu.gpu.queue.onSubmittedWorkDone.mockImplementation(() => {
      env.events.push("queue:start");
      return queue.promise;
    });
    env.gpu.settled.mockImplementation(() => {
      env.events.push("settled:start");
      return settled.promise;
    });
    const rendering = renderThumbnail(env.gpu as never, env.surface as never);
    await vi.waitFor(() => {
      expect(env.gpu.gpu.queue.onSubmittedWorkDone).toHaveBeenCalledOnce();
      expect(env.gpu.settled).toHaveBeenCalledOnce();
    });
    for (const texture of env.textures)
      expect(texture.destroy).not.toHaveBeenCalled();
    settled.resolve();
    await Promise.resolve();
    for (const texture of env.textures)
      expect(texture.destroy).not.toHaveBeenCalled();
    queue.resolve();
    await rendering;
    for (const texture of env.textures)
      expect(texture.destroy).toHaveBeenCalledOnce();
    for (const target of env.targets)
      expect(target.color.destroy).toHaveBeenCalledOnce();
    expect(env.gpu.dispose).not.toHaveBeenCalled();
  });

  test("uses default and explicit thumbnail times in the uniforms", async () => {
    const defaultEnv = setup();
    await renderThumbnail(defaultEnv.gpu as never, defaultEnv.surface as never);
    const defaultComposite = defaultEnv.effects.find(
      (value) => value.label === "nextjs-flare-composite"
    )!;
    const placement = centeredPlacement(200, 100, 100);
    expect(defaultComposite.set.mock.lastCall?.[0].params.light).toEqual(
      mapAutonomousLight(4.2, placement)
    );
    expect(defaultComposite.set.mock.lastCall?.[0].params.frameIndex).toBe(0);

    const explicitEnv = setup();
    await renderThumbnail(
      explicitEnv.gpu as never,
      explicitEnv.surface as never,
      {
        time: 10,
      }
    );
    const explicitComposite = explicitEnv.effects.find(
      (value) => value.label === "nextjs-flare-composite"
    )!;
    expect(explicitComposite.set.mock.lastCall?.[0].params.light).toEqual(
      mapAutonomousLight(10, placement)
    );
    expect(explicitComposite.set.mock.lastCall?.[0].params.rimIntensity).toBe(
      0.2
    );
  });

  test("waits both sync-safe barriers and reports the first barrier failure", async () => {
    const env = setup();
    const queueError = new Error("queue failed");
    const settledError = new Error("settled failed");
    env.gpu.gpu.queue.onSubmittedWorkDone.mockImplementation(() => {
      throw queueError;
    });
    env.gpu.settled.mockRejectedValue(settledError);

    await expect(
      renderThumbnail(env.gpu as never, env.surface as never)
    ).rejects.toBe(queueError);
    expect(env.gpu.gpu.queue.onSubmittedWorkDone).toHaveBeenCalledOnce();
    expect(env.gpu.settled).toHaveBeenCalledOnce();
    for (const texture of env.textures)
      expect(texture.destroy).toHaveBeenCalledOnce();
    for (const target of env.targets)
      expect(target.color.destroy).toHaveBeenCalledOnce();
  });

  test("preserves a render error over barriers and best-effort cleanup", async () => {
    const env = setup();
    const primary = new Error("render failed");
    env.state.frameError = primary;
    env.gpu.gpu.queue.onSubmittedWorkDone.mockRejectedValue(
      new Error("queue failed")
    );
    env.gpu.settled.mockRejectedValue(new Error("settled failed"));
    env.state.destroy = () => {
      throw new Error("cleanup failed");
    };

    await expect(
      renderThumbnail(env.gpu as never, env.surface as never)
    ).rejects.toBe(primary);
    expect(env.gpu.gpu.queue.onSubmittedWorkDone).toHaveBeenCalledOnce();
    expect(env.gpu.settled).toHaveBeenCalledOnce();
    for (const texture of env.textures)
      expect(texture.destroy).toHaveBeenCalledOnce();
    for (const target of env.targets)
      expect(target.color.destroy).toHaveBeenCalledOnce();
    expect(env.gpu.dispose).not.toHaveBeenCalled();
  });

  test("cleans partial pipeline construction and still runs both barriers", async () => {
    const env = setup();
    const primary = new Error("blue-noise upload failed");
    env.state.uploadError = primary;
    await expect(
      renderThumbnail(env.gpu as never, env.surface as never)
    ).rejects.toBe(primary);
    expect(env.textures).toHaveLength(1);
    expect(env.textures[0]?.destroy).toHaveBeenCalledOnce();
    expect(env.gpu.gpu.queue.onSubmittedWorkDone).toHaveBeenCalledOnce();
    expect(env.gpu.settled).toHaveBeenCalledOnce();
  });

  test("releases blue noise when effect construction fails partway", async () => {
    const env = setup();
    const primary = new Error("effect construction failed");
    env.state.failEffectAt = 3;
    env.state.effectError = primary;
    await expect(
      renderThumbnail(env.gpu as never, env.surface as never)
    ).rejects.toBe(primary);
    expect(env.effects).toHaveLength(2);
    expect(env.textures).toHaveLength(1);
    expect(env.textures[0]?.destroy).toHaveBeenCalledOnce();
    expect(env.gpu.gpu.queue.onSubmittedWorkDone).toHaveBeenCalledOnce();
    expect(env.gpu.settled).toHaveBeenCalledOnce();
  });
});
