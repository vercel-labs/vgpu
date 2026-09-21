import { afterEach, expect, test, vi } from "vitest";

const pipeline = vi.hoisted(() => ({
  createBlit: vi.fn(),
  createScene: vi.fn(),
  renderScene: vi.fn(),
}));
const api = vi.hoisted(() => ({ frame: vi.fn(), target: vi.fn() }));

vi.mock("./scene-pipeline", () => ({
  createBlit: pipeline.createBlit,
  createScene: pipeline.createScene,
  renderScene: pipeline.renderScene,
  DEFAULT_INSTANCE_COUNT: 50,
}));
vi.mock("vgpu", () => ({ frame: api.frame, target: api.target }));

import { renderThumbnail } from "./render-thumbnail";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function setup() {
  const destroyTarget = vi.fn();
  const destroyGeometry = vi.fn();
  const compile = vi.fn(async () => {});
  const queue = vi.fn(async () => {});
  const settled = vi.fn(async () => {});
  const colorTarget = {
    size: [128, 72],
    format: "rgba8unorm",
    destroy: destroyTarget,
  };
  const scene = {
    geometry: { destroy: destroyGeometry },
    draw: {},
    bundle: {},
    extent: 32,
  };
  const blit = { compile };
  const gpu = {
    gpu: { queue: { onSubmittedWorkDone: queue } },
    settled,
    dispose: vi.fn(),
  };
  const output = { size: [128, 72], format: "rgba8unorm" };

  api.target.mockReturnValue(colorTarget);
  api.frame.mockImplementation(
    (_gpu: unknown, record: (frame: unknown) => void) => record({ id: "frame" })
  );
  pipeline.createScene.mockResolvedValue(scene);
  pipeline.createBlit.mockReturnValue(blit);

  return {
    blit,
    colorTarget,
    compile,
    destroyGeometry,
    destroyTarget,
    gpu,
    output,
    queue,
    scene,
    settled,
  };
}

afterEach(() => {
  api.frame.mockReset();
  api.target.mockReset();
  pipeline.createBlit.mockReset();
  pipeline.createScene.mockReset();
  pipeline.renderScene.mockReset();
});

test("renders the exact default count, time, warmup, and offscreen chain", async () => {
  const env = setup();
  await renderThumbnail(env.gpu as never, env.output as never);

  expect(api.target).toHaveBeenCalledWith(env.gpu, {
    size: [128, 72],
    format: "rgba8unorm",
    depth: true,
  });
  expect(pipeline.createScene).toHaveBeenCalledWith(
    env.gpu,
    env.colorTarget,
    50
  );
  expect(pipeline.createBlit).toHaveBeenCalledWith(
    env.gpu,
    env.colorTarget,
    env.output
  );
  expect(env.compile).toHaveBeenCalledWith(env.output);
  expect(api.frame).toHaveBeenCalledTimes(3);
  expect(pipeline.renderScene.mock.calls.map((call) => call[5])).toEqual([
    2.4 + 1 / 60,
    2.4 + 2 / 60,
    2.4 + 3 / 60,
  ]);
  expect(pipeline.renderScene).toHaveBeenLastCalledWith(
    { id: "frame" },
    env.scene,
    env.blit,
    env.colorTarget,
    env.output,
    2.4 + 3 / 60
  );
  expect(env.queue).toHaveBeenCalledOnce();
  expect(env.settled).toHaveBeenCalledOnce();
  expect(env.destroyGeometry).toHaveBeenCalledOnce();
  expect(env.destroyTarget).toHaveBeenCalledOnce();
  expect(env.gpu.dispose).not.toHaveBeenCalled();
});

test("preserves custom time, dt, and warmup frame semantics", async () => {
  const env = setup();
  await renderThumbnail(env.gpu as never, env.output as never, {
    time: 7.25,
    dt: 1 / 30,
    warmupFrames: 5,
  });

  expect(api.frame).toHaveBeenCalledTimes(5);
  let time = 7.25;
  const expected = Array.from({ length: 5 }, () => (time += 1 / 30));
  expect(pipeline.renderScene.mock.calls.map((call) => call[5])).toEqual(
    expected
  );
});

test("waits for both lazy preparations before preserving a synchronous scene failure", async () => {
  const env = setup();
  const primary = new Error("scene failed");
  const pendingCompile = deferred<void>();
  pipeline.createScene.mockImplementationOnce(() => {
    throw primary;
  });
  env.compile.mockReturnValueOnce(pendingCompile.promise);

  const rendering = renderThumbnail(env.gpu as never, env.output as never);
  await vi.waitFor(() => expect(env.compile).toHaveBeenCalledOnce());
  expect(env.queue).not.toHaveBeenCalled();
  expect(env.destroyTarget).not.toHaveBeenCalled();
  pendingCompile.resolve();

  await expect(rendering).rejects.toBe(primary);
  expect(env.queue).toHaveBeenCalledOnce();
  expect(env.settled).toHaveBeenCalledOnce();
  expect(env.destroyTarget).toHaveBeenCalledOnce();
  expect(env.destroyGeometry).not.toHaveBeenCalled();
});

test("cleans a fulfilled scene when blit compilation fails", async () => {
  const env = setup();
  const primary = new Error("blit failed");
  env.compile.mockRejectedValueOnce(primary);

  await expect(
    renderThumbnail(env.gpu as never, env.output as never)
  ).rejects.toBe(primary);
  expect(env.destroyGeometry).toHaveBeenCalledOnce();
  expect(env.destroyTarget).toHaveBeenCalledOnce();
  expect(env.queue).toHaveBeenCalledOnce();
  expect(env.settled).toHaveBeenCalledOnce();
});

test("waits for both barriers before destroying local resources", async () => {
  const env = setup();
  const queue = deferred<void>();
  const settled = deferred<void>();
  env.queue.mockReturnValueOnce(queue.promise);
  env.settled.mockReturnValueOnce(settled.promise);

  const rendering = renderThumbnail(env.gpu as never, env.output as never);
  await vi.waitFor(() => expect(env.queue).toHaveBeenCalledOnce());
  expect(env.settled).toHaveBeenCalledOnce();
  expect(env.destroyGeometry).not.toHaveBeenCalled();
  queue.resolve();
  await Promise.resolve();
  expect(env.destroyGeometry).not.toHaveBeenCalled();
  settled.resolve();
  await rendering;
  expect(env.destroyGeometry).toHaveBeenCalledOnce();
  expect(env.destroyTarget).toHaveBeenCalledOnce();
});

test.each([
  { name: "queue sync failure", queueFails: true, settledFails: false },
  { name: "settled sync failure", queueFails: false, settledFails: true },
  { name: "both barrier failures", queueFails: true, settledFails: true },
])(
  "attempts both barriers on $name and preserves deterministic identity",
  async ({ queueFails, settledFails }) => {
    const env = setup();
    const queueFailure = new Error("queue failed");
    const settledFailure = new Error("settled failed");
    if (queueFails)
      env.queue.mockImplementationOnce(() => {
        throw queueFailure;
      });
    if (settledFails)
      env.settled.mockImplementationOnce(() => {
        throw settledFailure;
      });

    await expect(
      renderThumbnail(env.gpu as never, env.output as never)
    ).rejects.toBe(queueFails ? queueFailure : settledFailure);
    expect(env.queue).toHaveBeenCalledOnce();
    expect(env.settled).toHaveBeenCalledOnce();
    expect(env.destroyGeometry).toHaveBeenCalledOnce();
    expect(env.destroyTarget).toHaveBeenCalledOnce();
  }
);

test("successful rendering rejects the first cleanup failure after attempting both children", async () => {
  const env = setup();
  const geometryFailure = new Error("geometry cleanup failed");
  const targetFailure = new Error("target cleanup failed");
  env.destroyGeometry.mockImplementationOnce(() => {
    throw geometryFailure;
  });
  env.destroyTarget.mockImplementationOnce(() => {
    throw targetFailure;
  });

  await expect(
    renderThumbnail(env.gpu as never, env.output as never)
  ).rejects.toBe(geometryFailure);
  expect(env.destroyGeometry).toHaveBeenCalledOnce();
  expect(env.destroyTarget).toHaveBeenCalledOnce();
  expect(env.gpu.dispose).not.toHaveBeenCalled();
});

test("successful rendering exposes target cleanup when geometry cleanup succeeds", async () => {
  const env = setup();
  const targetFailure = new Error("target cleanup failed");
  env.destroyTarget.mockImplementationOnce(() => {
    throw targetFailure;
  });

  await expect(
    renderThumbnail(env.gpu as never, env.output as never)
  ).rejects.toBe(targetFailure);
  expect(env.destroyGeometry).toHaveBeenCalledOnce();
  expect(env.destroyTarget).toHaveBeenCalledOnce();
  expect(env.gpu.dispose).not.toHaveBeenCalled();
});

test("barrier identity outranks cleanup failures", async () => {
  const env = setup();
  const barrierFailure = new Error("queue failed");
  env.queue.mockRejectedValueOnce(barrierFailure);
  env.destroyGeometry.mockImplementationOnce(() => {
    throw new Error("geometry cleanup failed");
  });
  env.destroyTarget.mockImplementationOnce(() => {
    throw new Error("target cleanup failed");
  });

  await expect(
    renderThumbnail(env.gpu as never, env.output as never)
  ).rejects.toBe(barrierFailure);
  expect(env.destroyGeometry).toHaveBeenCalledOnce();
  expect(env.destroyTarget).toHaveBeenCalledOnce();
  expect(env.gpu.dispose).not.toHaveBeenCalled();
});

test("render identity outranks barrier and cleanup failures", async () => {
  const env = setup();
  const primary = new Error("frame failed");
  pipeline.renderScene.mockImplementationOnce(() => {
    throw primary;
  });
  env.queue.mockRejectedValueOnce(new Error("queue failed"));
  env.settled.mockRejectedValueOnce(new Error("settled failed"));
  env.destroyGeometry.mockImplementationOnce(() => {
    throw new Error("geometry cleanup failed");
  });
  env.destroyTarget.mockImplementationOnce(() => {
    throw new Error("target cleanup failed");
  });

  await expect(
    renderThumbnail(env.gpu as never, env.output as never)
  ).rejects.toBe(primary);
  expect(env.queue).toHaveBeenCalledOnce();
  expect(env.settled).toHaveBeenCalledOnce();
  expect(env.destroyGeometry).toHaveBeenCalledOnce();
  expect(env.destroyTarget).toHaveBeenCalledOnce();
});

test("still drains the shared GPU after target allocation fails", async () => {
  const env = setup();
  const primary = new Error("target allocation failed");
  api.target.mockImplementationOnce(() => {
    throw primary;
  });

  await expect(
    renderThumbnail(env.gpu as never, env.output as never)
  ).rejects.toBe(primary);
  expect(pipeline.createScene).not.toHaveBeenCalled();
  expect(env.queue).toHaveBeenCalledOnce();
  expect(env.settled).toHaveBeenCalledOnce();
  expect(env.gpu.dispose).not.toHaveBeenCalled();
});
