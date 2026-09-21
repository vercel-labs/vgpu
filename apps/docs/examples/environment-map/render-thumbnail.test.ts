import { beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  aspectOf: vi.fn(() => 16 / 9),
  cameraView: vi.fn(() => ({ aspect: 0, pitch: 0, yaw: 0 })),
  createScene: vi.fn(),
  destroyScene: vi.fn(),
  frame: vi.fn(),
  render: vi.fn(),
}));

vi.mock("vgpu", () => ({
  frame: mocks.frame,
}));
vi.mock("./camera", () => ({
  cameraView: mocks.cameraView,
}));
vi.mock("./scene", () => ({
  aspectOf: mocks.aspectOf,
  createScene: mocks.createScene,
  destroyScene: mocks.destroyScene,
  render: mocks.render,
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
  const output = {
    format: "rgba8unorm" as GPUTextureFormat,
    size: [160, 90] as [number, number],
  };
  mocks.aspectOf.mockReturnValue(16 / 9);
  mocks.createScene.mockResolvedValue(scene);
  mocks.destroyScene.mockImplementation(() => events.push("destroy"));
  mocks.frame.mockImplementation(
    (_gpu: unknown, encode: (currentFrame: unknown) => void) => {
      encode({ frame: true });
    }
  );
  mocks.render.mockImplementation(
    (_frame, _scene, _output, _view, time: number) =>
      events.push(`render:${time}`)
  );
  return { events, gpu, output, scene };
}

beforeEach(() => {
  vi.resetAllMocks();
});

test("preserves warmup, time, camera, and shared-GPU semantics", async () => {
  const state = setup();
  await renderThumbnail(state.gpu as never, state.output as never, {
    dt: 0.25,
    time: 4,
    warmupFrames: 3,
  });

  expect(mocks.render.mock.calls.map((call) => call[4])).toEqual([
    4.25, 4.5, 4.75,
  ]);
  expect(mocks.cameraView.mock.calls).toEqual([
    [0.62 + 4.25 * 0.09, 0.16, 16 / 9],
    [0.62 + 4.5 * 0.09, 0.16, 16 / 9],
    [0.62 + 4.75 * 0.09, 0.16, 16 / 9],
  ]);
  expect(state.events.slice(-3)).toEqual(["queue", "settled", "destroy"]);
  expect(state.gpu.dispose).not.toHaveBeenCalled();
});

test("renders at least one frame for a zero warmup request", async () => {
  const state = setup();
  await renderThumbnail(state.gpu as never, state.output as never, {
    warmupFrames: 0,
  });
  expect(mocks.render).toHaveBeenCalledOnce();
});

test.each(["queue", "settled"] as const)(
  "waits for the %s barrier when it resolves last",
  async (last) => {
    const state = setup();
    const queue = deferred();
    const settled = deferred();
    state.gpu.gpu.queue.onSubmittedWorkDone.mockReturnValue(queue.promise);
    state.gpu.settled.mockReturnValue(settled.promise);

    const rendering = renderThumbnail(
      state.gpu as never,
      state.output as never
    );
    await vi.waitFor(() => {
      expect(state.gpu.gpu.queue.onSubmittedWorkDone).toHaveBeenCalledOnce();
      expect(state.gpu.settled).toHaveBeenCalledOnce();
    });
    (last === "queue" ? settled : queue).resolve();
    await Promise.resolve();
    expect(mocks.destroyScene).not.toHaveBeenCalled();
    (last === "queue" ? queue : settled).resolve();

    await rendering;
    expect(mocks.destroyScene).toHaveBeenCalledWith(state.scene);
  }
);

test("construction failure still attempts both barriers without inventing child ownership", async () => {
  const state = setup();
  const primary = new Error("scene failed");
  mocks.createScene.mockRejectedValue(primary);

  await expect(
    renderThumbnail(state.gpu as never, state.output as never)
  ).rejects.toBe(primary);
  expect(state.gpu.gpu.queue.onSubmittedWorkDone).toHaveBeenCalledOnce();
  expect(state.gpu.settled).toHaveBeenCalledOnce();
  expect(mocks.destroyScene).not.toHaveBeenCalled();
  expect(state.gpu.dispose).not.toHaveBeenCalled();
});

test("render failure remains primary across synchronous barriers and cleanup failures", async () => {
  const state = setup();
  const primary = new Error("render failed");
  mocks.render.mockImplementation(() => {
    throw primary;
  });
  state.gpu.gpu.queue.onSubmittedWorkDone.mockImplementation(() => {
    throw new Error("queue failed");
  });
  state.gpu.settled.mockRejectedValue(new Error("settled failed"));
  mocks.destroyScene.mockImplementation(() => {
    throw new Error("cleanup failed");
  });

  await expect(
    renderThumbnail(state.gpu as never, state.output as never)
  ).rejects.toBe(primary);
  expect(state.gpu.gpu.queue.onSubmittedWorkDone).toHaveBeenCalledOnce();
  expect(state.gpu.settled).toHaveBeenCalledOnce();
  expect(mocks.destroyScene).toHaveBeenCalledWith(state.scene);
  expect(state.gpu.dispose).not.toHaveBeenCalled();
});

test("successful rendering reports the first barrier error after cleanup", async () => {
  const state = setup();
  const queueError = new Error("queue failed");
  state.gpu.gpu.queue.onSubmittedWorkDone.mockRejectedValue(queueError);
  state.gpu.settled.mockRejectedValue(new Error("settled failed"));
  mocks.destroyScene.mockImplementation(() => {
    throw new Error("cleanup failed");
  });

  await expect(
    renderThumbnail(state.gpu as never, state.output as never)
  ).rejects.toBe(queueError);
  expect(state.gpu.settled).toHaveBeenCalledOnce();
  expect(mocks.destroyScene).toHaveBeenCalledOnce();
});
