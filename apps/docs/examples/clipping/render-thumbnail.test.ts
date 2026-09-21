import { afterEach, expect, test, vi } from "vitest";

const sceneFns = vi.hoisted(() => ({
  createScene: vi.fn(),
  destroyScene: vi.fn(),
  renderScene: vi.fn(),
}));
const vgpuFns = vi.hoisted(() => ({
  frame: (gpu: any, ...args: any[]) => gpu.fns.frame(...args),
}));

vi.mock("vgpu", () => vgpuFns);
vi.mock("./scene", () => sceneFns);

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
  const geometries = [
    { destroy: vi.fn(() => events.push("body.destroy")) },
    { destroy: vi.fn(() => events.push("cap.destroy")) },
  ];
  const scene = { body: {}, cap: {}, geometries };
  sceneFns.createScene.mockReturnValue(scene);
  sceneFns.destroyScene.mockImplementation((value: typeof scene) => {
    let firstError: unknown;
    for (const geometry of value.geometries) {
      try {
        geometry.destroy();
      } catch (error) {
        firstError ??= error;
      }
    }
    if (firstError) throw firstError;
  });
  const queue = vi.fn(async () => {
    events.push("queue");
  });
  const settled = vi.fn(async () => {
    events.push("settled");
  });
  const gpu = {
    gpu: { queue: { onSubmittedWorkDone: queue } },
    settled,
    dispose: vi.fn(),
    fns: {
      frame: vi.fn((render: (frame: unknown) => void) => {
        events.push("frame");
        render({ id: "frame" });
      }),
    },
  };
  const output = { size: [320, 180] };
  return { events, geometries, scene, queue, settled, gpu, output };
}

afterEach(() => vi.resetAllMocks());

test("preserves default, custom, and explicit-zero thumbnail times", async () => {
  const env = setup();
  await renderThumbnail(env.gpu as never, env.output as never);
  await renderThumbnail(env.gpu as never, env.output as never, { time: 7.25 });
  await renderThumbnail(env.gpu as never, env.output as never, { time: 0 });

  expect(sceneFns.renderScene.mock.calls.map((call) => call[3])).toEqual([
    2.4, 7.25, 0,
  ]);
  expect(env.gpu.dispose).not.toHaveBeenCalled();
});

test("waits for queue then settled barriers before cleaning both geometries", async () => {
  const env = setup();
  const queue = deferred<void>();
  const settled = deferred<void>();
  env.queue.mockReturnValueOnce(queue.promise);
  env.settled.mockReturnValueOnce(settled.promise);

  const rendering = renderThumbnail(env.gpu as never, env.output as never);
  await vi.waitFor(() => {
    expect(env.queue).toHaveBeenCalledOnce();
    expect(env.settled).toHaveBeenCalledOnce();
  });
  queue.resolve();
  await Promise.resolve();
  expect(sceneFns.destroyScene).not.toHaveBeenCalled();
  settled.resolve();

  await rendering;
  expect(sceneFns.destroyScene).toHaveBeenCalledWith(env.scene);
  expect(
    env.geometries.every((item) => item.destroy.mock.calls.length === 1)
  ).toBe(true);
});

test("waits for settled then queue barriers before cleanup", async () => {
  const env = setup();
  const queue = deferred<void>();
  const settled = deferred<void>();
  env.queue.mockReturnValueOnce(queue.promise);
  env.settled.mockReturnValueOnce(settled.promise);

  const rendering = renderThumbnail(env.gpu as never, env.output as never);
  settled.resolve();
  await Promise.resolve();
  expect(sceneFns.destroyScene).not.toHaveBeenCalled();
  queue.resolve();

  await rendering;
  expect(sceneFns.destroyScene).toHaveBeenCalledOnce();
});

test("preserves render identity across barrier and best-effort cleanup failures", async () => {
  const env = setup();
  const failure = new Error("render failed");
  env.gpu.fns.frame.mockImplementationOnce(() => {
    throw failure;
  });
  env.queue.mockRejectedValueOnce(new Error("queue failed"));
  env.settled.mockRejectedValueOnce(new Error("settled failed"));
  env.geometries[0].destroy.mockImplementationOnce(() => {
    env.events.push("body.destroy");
    throw new Error("body cleanup failed");
  });
  env.geometries[1].destroy.mockImplementationOnce(() => {
    env.events.push("cap.destroy");
    throw new Error("cap cleanup failed");
  });

  await expect(
    renderThumbnail(env.gpu as never, env.output as never)
  ).rejects.toBe(failure);
  expect(env.queue).toHaveBeenCalledOnce();
  expect(env.settled).toHaveBeenCalledOnce();
  expect(env.geometries[0].destroy).toHaveBeenCalledOnce();
  expect(env.geometries[1].destroy).toHaveBeenCalledOnce();
  expect(env.gpu.dispose).not.toHaveBeenCalled();
});

test("reports the first sync-safe barrier failure after successful rendering", async () => {
  const env = setup();
  const failure = new Error("queue sync failure");
  env.queue.mockImplementationOnce(() => {
    throw failure;
  });
  env.settled.mockRejectedValueOnce(new Error("settled failure"));

  await expect(
    renderThumbnail(env.gpu as never, env.output as never)
  ).rejects.toBe(failure);
  expect(env.queue).toHaveBeenCalledOnce();
  expect(env.settled).toHaveBeenCalledOnce();
  expect(sceneFns.destroyScene).toHaveBeenCalledOnce();
});

test("still runs shared barriers after transactional scene construction fails", async () => {
  const env = setup();
  const failure = new Error("scene failed");
  sceneFns.createScene.mockImplementationOnce(() => {
    throw failure;
  });

  await expect(
    renderThumbnail(env.gpu as never, env.output as never)
  ).rejects.toBe(failure);
  expect(env.gpu.fns.frame).not.toHaveBeenCalled();
  expect(env.queue).toHaveBeenCalledOnce();
  expect(env.settled).toHaveBeenCalledOnce();
  expect(sceneFns.destroyScene).not.toHaveBeenCalled();
});
