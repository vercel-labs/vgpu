import { afterEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  aspectOf: vi.fn(() => 16 / 9),
  cameraView: vi.fn(() => ({ view: true })),
  createScene: vi.fn(),
  destroyScene: vi.fn(),
  renderScene: vi.fn(),
}));

vi.mock("./camera", () => ({
  DEFAULT_PITCH: 0.42,
  DEFAULT_YAW: 1.25,
  cameraView: mocks.cameraView,
}));
vi.mock("./scene", () => ({
  DEFAULT_CONTROLS: { controls: true },
  aspectOf: mocks.aspectOf,
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
  const scene = { scene: true };
  const gpu = {
    dispose: vi.fn(),
    gpu: {
      queue: {
        onSubmittedWorkDone: vi.fn(async () => {
          events.push("queue");
        }),
      },
    },
    settled: vi.fn(async () => {
      events.push("settled");
    }),
  };
  const output = { size: [160, 90] };
  mocks.aspectOf.mockReturnValue(16 / 9);
  mocks.cameraView.mockReturnValue({ view: true });
  mocks.createScene.mockResolvedValue(scene);
  mocks.destroyScene.mockImplementation(() => events.push("destroy"));
  mocks.renderScene.mockImplementation(() => events.push("render"));
  return { events, gpu, output, scene };
}

afterEach(() => {
  vi.resetAllMocks();
});

test("renders requested frames, drains work, and only destroys shared children", async () => {
  const env = setup();
  await renderThumbnail(env.gpu as never, env.output as never, {
    warmupFrames: 4,
  });

  expect(mocks.renderScene).toHaveBeenCalledTimes(4);
  expect(mocks.cameraView).toHaveBeenCalledWith(1.25, 0.42, 16 / 9);
  expect(env.events.slice(-3)).toEqual(["queue", "settled", "destroy"]);
  expect(env.gpu.dispose).not.toHaveBeenCalled();
});

test("waits for both barriers before destroying shared GPU children", async () => {
  const env = setup();
  const queue = deferred();
  const settled = deferred();
  env.gpu.gpu.queue.onSubmittedWorkDone.mockReturnValue(queue.promise);
  env.gpu.settled.mockReturnValue(settled.promise);
  const rendering = renderThumbnail(env.gpu as never, env.output as never);
  await vi.waitFor(() => {
    expect(env.gpu.settled).toHaveBeenCalledTimes(1);
  });

  queue.resolve();
  await Promise.resolve();
  expect(mocks.destroyScene).not.toHaveBeenCalled();
  settled.resolve();
  await rendering;
  expect(mocks.destroyScene).toHaveBeenCalledWith(env.scene);
});

test("render errors survive barrier and cleanup failures", async () => {
  const env = setup();
  const primary = new Error("render failed");
  mocks.renderScene.mockImplementation(() => {
    throw primary;
  });
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
  expect(env.gpu.gpu.queue.onSubmittedWorkDone).toHaveBeenCalledTimes(1);
  expect(env.gpu.settled).toHaveBeenCalledTimes(1);
  expect(mocks.destroyScene).toHaveBeenCalledTimes(1);
});

test("scene creation errors still drain without inventing child cleanup", async () => {
  const env = setup();
  const primary = new Error("scene failed");
  mocks.createScene.mockRejectedValue(primary);

  await expect(
    renderThumbnail(env.gpu as never, env.output as never)
  ).rejects.toBe(primary);
  expect(env.gpu.gpu.queue.onSubmittedWorkDone).toHaveBeenCalledTimes(1);
  expect(env.gpu.settled).toHaveBeenCalledTimes(1);
  expect(mocks.destroyScene).not.toHaveBeenCalled();
});

test("successful rendering reports the first barrier or cleanup failure", async () => {
  const env = setup();
  const barrier = new Error("queue failed");
  env.gpu.gpu.queue.onSubmittedWorkDone.mockRejectedValue(barrier);
  mocks.destroyScene.mockImplementation(() => {
    throw new Error("cleanup failed");
  });

  await expect(
    renderThumbnail(env.gpu as never, env.output as never)
  ).rejects.toBe(barrier);
  expect(env.gpu.settled).toHaveBeenCalledTimes(1);
  expect(mocks.destroyScene).toHaveBeenCalledTimes(1);
});
