import { afterEach, expect, test, vi } from "vitest";

const sceneFns = vi.hoisted(() => ({
  createBlit: vi.fn(),
  createScene: vi.fn(),
  renderScene: vi.fn(),
}));
const vgpuFns = vi.hoisted(() => ({
  frame: (gpu: any, ...args: any[]) => gpu.fns.frame(...args),
  target: (gpu: any, ...args: any[]) => gpu.fns.target(...args),
}));

vi.mock("vgpu", () => vgpuFns);
vi.mock("./scene-pipeline", () => sceneFns);

import { renderThumbnail } from "./render-thumbnail";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function setup() {
  const events: string[] = [];
  const colorTarget = {
    size: [160, 90],
    format: "rgba8unorm",
    destroy: vi.fn(() => events.push("target.destroy")),
  };
  const geometry = { destroy: vi.fn(() => events.push("geometry.destroy")) };
  const scene = { geometry, draws: [], bundle: {} };
  const blit = { compile: vi.fn(async () => undefined) };
  const drain = vi.fn(async () => {
    events.push("queue");
  });
  const settled = vi.fn(async () => {
    events.push("settled");
  });
  const gpu = {
    gpu: { queue: { onSubmittedWorkDone: drain } },
    settled,
    dispose: vi.fn(),
    fns: {
      target: vi.fn(() => colorTarget),
      frame: vi.fn((render: (frame: unknown) => void) => {
        events.push("frame");
        render({});
      }),
    },
  };
  const output = { size: [160, 90], format: "rgba8unorm" };
  sceneFns.createBlit.mockReturnValue(blit);
  sceneFns.createScene.mockResolvedValue(scene);
  return {
    events,
    colorTarget,
    geometry,
    scene,
    blit,
    drain,
    settled,
    gpu,
    output,
  };
}

afterEach(() => vi.clearAllMocks());

test("preserves thumbnail time and warmup semantics, then drains shared work", async () => {
  const env = setup();
  await renderThumbnail(env.gpu as never, env.output as never, {
    warmupFrames: 3,
    time: 2.4,
    dt: 1 / 60,
  });

  expect(env.gpu.fns.frame).toHaveBeenCalledTimes(3);
  expect(sceneFns.renderScene.mock.calls.map((call) => call[5])).toEqual([
    2.4 + 1 / 60,
    2.4 + 2 / 60,
    2.4 + 3 / 60,
  ]);
  expect(env.events.slice(-4)).toEqual([
    "queue",
    "settled",
    "geometry.destroy",
    "target.destroy",
  ]);
  expect(env.gpu.dispose).not.toHaveBeenCalled();
});

test("keeps an explicit zero warmup as zero submitted frames", async () => {
  const env = setup();
  await renderThumbnail(env.gpu as never, env.output as never, {
    warmupFrames: 0,
  });
  expect(env.gpu.fns.frame).not.toHaveBeenCalled();
  expect(sceneFns.renderScene).not.toHaveBeenCalled();
});

test("waits for both barriers and every cleanup without replacing a render failure", async () => {
  const env = setup();
  const failed = new Error("render failed");
  const queue = deferred<void>();
  const settled = deferred<void>();
  env.drain.mockReturnValueOnce(queue.promise);
  env.settled.mockReturnValueOnce(settled.promise);
  env.gpu.fns.frame.mockImplementationOnce(() => {
    throw failed;
  });
  env.geometry.destroy.mockImplementationOnce(() => {
    env.events.push("geometry.destroy");
    throw new Error("cleanup failed");
  });

  const rendering = renderThumbnail(env.gpu as never, env.output as never);
  await vi.waitFor(() => {
    expect(env.drain).toHaveBeenCalledOnce();
    expect(env.settled).toHaveBeenCalledOnce();
  });
  expect(env.geometry.destroy).not.toHaveBeenCalled();
  queue.reject(new Error("queue failed"));
  await Promise.resolve();
  expect(env.geometry.destroy).not.toHaveBeenCalled();
  settled.resolve();

  await expect(rendering).rejects.toBe(failed);
  expect(env.geometry.destroy).toHaveBeenCalledOnce();
  expect(env.colorTarget.destroy).toHaveBeenCalledOnce();
});

test("reports the first sync-safe barrier failure after successful rendering", async () => {
  const env = setup();
  const queueFailure = new Error("queue sync failure");
  const settledFailure = new Error("settled failure");
  env.drain.mockImplementationOnce(() => {
    throw queueFailure;
  });
  env.settled.mockRejectedValueOnce(settledFailure);

  await expect(
    renderThumbnail(env.gpu as never, env.output as never)
  ).rejects.toBe(queueFailure);
  expect(env.drain).toHaveBeenCalledOnce();
  expect(env.settled).toHaveBeenCalledOnce();
  expect(env.geometry.destroy).toHaveBeenCalledOnce();
  expect(env.colorTarget.destroy).toHaveBeenCalledOnce();
});

test("still runs shared barriers when target allocation throws synchronously", async () => {
  const env = setup();
  const failed = new Error("target allocation failed");
  env.gpu.fns.target.mockImplementationOnce(() => {
    throw failed;
  });

  await expect(
    renderThumbnail(env.gpu as never, env.output as never)
  ).rejects.toBe(failed);
  expect(env.drain).toHaveBeenCalledOnce();
  expect(env.settled).toHaveBeenCalledOnce();
  expect(sceneFns.createBlit).not.toHaveBeenCalled();
});

test("waits for scene and blit preparation before transactional rollback", async () => {
  const env = setup();
  const failed = new Error("scene failed");
  const scene = deferred<never>();
  const blit = deferred<undefined>();
  sceneFns.createScene.mockReturnValueOnce(scene.promise);
  env.blit.compile.mockReturnValueOnce(blit.promise);

  const rendering = renderThumbnail(env.gpu as never, env.output as never);
  scene.reject(failed);
  await Promise.resolve();
  expect(env.drain).not.toHaveBeenCalled();
  expect(env.colorTarget.destroy).not.toHaveBeenCalled();
  blit.resolve(undefined);

  await expect(rendering).rejects.toBe(failed);
  expect(env.colorTarget.destroy).toHaveBeenCalledOnce();
});

test("cleans a completed scene when blit compilation fails", async () => {
  const env = setup();
  const failed = new Error("blit failed");
  env.blit.compile.mockRejectedValueOnce(failed);

  await expect(
    renderThumbnail(env.gpu as never, env.output as never)
  ).rejects.toBe(failed);
  expect(env.geometry.destroy).toHaveBeenCalledOnce();
  expect(env.colorTarget.destroy).toHaveBeenCalledOnce();
});
