import { afterEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  compileScene: vi.fn(),
  createScene: vi.fn(),
  destroyScene: vi.fn(),
  frame: vi.fn(),
  renderScene: vi.fn(),
}));

vi.mock("vgpu", () => ({
  frame: (gpu: unknown, render: (currentFrame: unknown) => void) =>
    mocks.frame(gpu, render),
}));
vi.mock("./pipeline", () => ({
  POSTER: { yaw: 0.58, pitch: 0.24 },
  compileScene: mocks.compileScene,
  createScene: mocks.createScene,
  destroyScene: mocks.destroyScene,
  renderScene: mocks.renderScene,
}));

import { renderThumbnail } from "./render-thumbnail";

function deferred() {
  let resolve!: () => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, reject, resolve };
}

function setup() {
  const events: string[] = [];
  const scene = {
    effects: {
      composite: {
        set: vi.fn(({ composite }) => {
          events.push(`bloom-${composite.bloomStrength}`);
        }),
      },
    },
  };
  let queueCalls = 0;
  const gpu = {
    dispose: vi.fn(),
    gpu: {
      queue: {
        onSubmittedWorkDone: vi.fn(async () => {
          events.push(`queue-${++queueCalls}`);
        }),
      },
    },
    settled: vi.fn(async () => {
      events.push("settled");
    }),
  };
  const output = {
    format: "rgba8unorm",
    color: { read: vi.fn(async () => {
      events.push("read");
      return new Uint8Array([1, 2, 3, 4]);
    }) },
    size: [160, 90] as const,
  };
  mocks.createScene.mockImplementation(() => {
    events.push("create");
    return scene;
  });
  mocks.compileScene.mockImplementation(async () => {
    events.push("compile");
  });
  mocks.frame.mockImplementation((_gpu, render) => render({ frame: true }));
  mocks.renderScene.mockImplementation((_frame, _scene, _output, orbit) => {
    events.push(`render-${orbit.yaw}-${orbit.pitch}`);
  });
  mocks.destroyScene.mockImplementation(() => {
    events.push("destroy");
  });
  return { events, gpu, output, scene };
}

afterEach(() => {
  vi.resetAllMocks();
});

test("preserves the fixed render sequence and callback variants without disposing shared GPU", async () => {
  const env = setup();
  const variants: string[] = [];
  await renderThumbnail(env.gpu as never, env.output as never, {
    warmupFrames: 99,
    onVariantRendered: async (variant, pixels, size) => {
      variants.push(variant);
      expect([...pixels]).toEqual([1, 2, 3, 4]);
      expect(size).toBe(env.output.size);
      env.events.push(`callback-${variant}`);
    },
  });

  expect(variants).toEqual(["static-repeat", "alternate-orbit", "bloom-off"]);
  expect(mocks.renderScene.mock.calls.map((call) => call[3])).toEqual([
    { yaw: 0.58, pitch: 0.24 },
    { yaw: 0.58, pitch: 0.24 },
    { yaw: -0.35, pitch: 0.1 },
    { yaw: 0.58, pitch: 0.24 },
    { yaw: 0.58, pitch: 0.24 },
  ]);
  expect(
    env.scene.effects.composite.set.mock.calls.map(
      ([values]) => values.composite.bloomStrength
    )
  ).toEqual([0, 0.65]);
  expect(env.events.slice(-3)).toEqual(["queue-6", "settled", "destroy"]);
  expect(env.gpu.dispose).not.toHaveBeenCalled();
});

test("waits for both final barriers before destroying shared children", async () => {
  const env = setup();
  const queue = deferred();
  const settled = deferred();
  env.gpu.gpu.queue.onSubmittedWorkDone.mockImplementation(() => {
    const call = env.gpu.gpu.queue.onSubmittedWorkDone.mock.calls.length;
    return call === 6 ? queue.promise : Promise.resolve();
  });
  env.gpu.settled.mockReturnValue(settled.promise);

  const rendering = renderThumbnail(env.gpu as never, env.output as never);
  await vi.waitFor(() => {
    expect(env.gpu.gpu.queue.onSubmittedWorkDone).toHaveBeenCalledTimes(6);
    expect(env.gpu.settled).toHaveBeenCalledOnce();
  });
  queue.resolve();
  await Promise.resolve();
  expect(mocks.destroyScene).not.toHaveBeenCalled();
  settled.resolve();
  await rendering;
  expect(mocks.destroyScene).toHaveBeenCalledWith(env.scene);
});

test("compile error survives synchronous barrier and cleanup failures", async () => {
  const env = setup();
  const primary = new Error("compile failed");
  mocks.compileScene.mockRejectedValue(primary);
  env.gpu.gpu.queue.onSubmittedWorkDone.mockImplementation(() => {
    throw new Error("queue failed");
  });
  env.gpu.settled.mockRejectedValue(new Error("settled failed"));
  mocks.destroyScene.mockImplementation(() => {
    throw new Error("cleanup failed");
  });

  await expect(
    renderThumbnail(env.gpu as never, env.output as never)
  ).rejects.toBe(primary);
  expect(env.gpu.gpu.queue.onSubmittedWorkDone).toHaveBeenCalledOnce();
  expect(env.gpu.settled).toHaveBeenCalledOnce();
  expect(mocks.destroyScene).toHaveBeenCalledOnce();
});

test("callback error remains primary while both barriers and cleanup still run", async () => {
  const env = setup();
  const primary = new Error("callback failed");
  mocks.destroyScene.mockImplementation(() => {
    env.events.push("destroy");
    throw new Error("cleanup failed");
  });

  await expect(
    renderThumbnail(env.gpu as never, env.output as never, {
      onVariantRendered: async () => {
        throw primary;
      },
    })
  ).rejects.toBe(primary);
  expect(env.gpu.settled).toHaveBeenCalledOnce();
  expect(mocks.destroyScene).toHaveBeenCalledOnce();
});

test("successful rendering reports the first barrier error and still cleans up", async () => {
  const env = setup();
  const barrier = new Error("queue barrier failed");
  env.gpu.gpu.queue.onSubmittedWorkDone.mockImplementation(() => {
    const call = env.gpu.gpu.queue.onSubmittedWorkDone.mock.calls.length;
    return call === 6 ? Promise.reject(barrier) : Promise.resolve();
  });
  env.gpu.settled.mockRejectedValue(new Error("settled failed"));
  mocks.destroyScene.mockImplementation(() => {
    throw new Error("cleanup failed");
  });

  await expect(
    renderThumbnail(env.gpu as never, env.output as never)
  ).rejects.toBe(barrier);
  expect(env.gpu.settled).toHaveBeenCalledOnce();
  expect(mocks.destroyScene).toHaveBeenCalledOnce();
});

test("construction failure drains shared GPU without inventing child ownership", async () => {
  const env = setup();
  const primary = new Error("scene failed");
  mocks.createScene.mockImplementation(() => {
    throw primary;
  });

  await expect(
    renderThumbnail(env.gpu as never, env.output as never)
  ).rejects.toBe(primary);
  expect(env.gpu.gpu.queue.onSubmittedWorkDone).toHaveBeenCalledOnce();
  expect(env.gpu.settled).toHaveBeenCalledOnce();
  expect(mocks.destroyScene).not.toHaveBeenCalled();
});
