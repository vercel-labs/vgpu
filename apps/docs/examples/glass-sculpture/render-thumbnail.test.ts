import { afterEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cameraView: vi.fn(() => ({ view: true })),
  createScene: vi.fn(),
  destroyScene: vi.fn(),
  renderScene: vi.fn(),
}));

vi.mock("./camera", () => ({
  DEFAULT_PITCH: 0.28,
  DEFAULT_YAW: 0.9,
  cameraView: mocks.cameraView,
}));
vi.mock("./scene", () => ({
  DEFAULT_CONTROLS: { renderScale: 0.75, shape: "gyroid" },
  createScene: mocks.createScene,
  destroyScene: mocks.destroyScene,
  renderScene: mocks.renderScene,
}));

import { renderThumbnail } from "./render-thumbnail";

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
  mocks.cameraView.mockReturnValue({ view: true });
  mocks.createScene.mockResolvedValue(scene);
  mocks.destroyScene.mockImplementation(() => events.push("destroy"));
  mocks.renderScene.mockImplementation(() => events.push("render"));
  return { events, gpu, output, scene };
}

afterEach(() => {
  vi.resetAllMocks();
});

test("renders a deterministic still at full scale, drains, and destroys only scene children", async () => {
  const env = setup();
  await renderThumbnail(env.gpu as never, env.output as never, {
    warmupFrames: 4,
  });

  expect(mocks.createScene).toHaveBeenCalledWith(
    env.gpu,
    env.output,
    expect.objectContaining({ renderScale: 1, shape: "gyroid" })
  );
  expect(mocks.renderScene).toHaveBeenCalledTimes(4);
  expect(mocks.cameraView).toHaveBeenCalledWith(0.9, 0.28);
  const state = mocks.renderScene.mock.calls[0]?.[5];
  expect(state).toEqual({
    clock: 0,
    light: { azimuth: 0.9, elevation: 0.55 },
    time: 1.6,
  });
  expect(env.events.slice(-3)).toEqual(["queue", "settled", "destroy"]);
  expect(env.gpu.dispose).not.toHaveBeenCalled();
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
  expect(mocks.destroyScene).toHaveBeenCalledTimes(1);
});
