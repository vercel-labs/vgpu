import { afterEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createAssets: vi.fn(),
  createScene: vi.fn(),
  destroyScene: vi.fn(),
  readFile: vi.fn(),
  renderScene: vi.fn(),
  setSettings: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({ readFile: mocks.readFile }));
vi.mock("pngjs", () => ({
  PNG: {
    sync: {
      read: vi.fn(() => ({
        data: new Uint8Array(24),
        height: 2,
        width: 3,
      })),
    },
  },
}));
vi.mock("./hero-glass-assets-core", () => ({
  createHeroGlassAssets: mocks.createAssets,
}));
vi.mock("./scene", () => ({
  createHeroFractalScene: mocks.createScene,
  destroyHeroFractalScene: mocks.destroyScene,
  renderHeroFractalScene: mocks.renderScene,
  setHeroFractalSceneSettings: mocks.setSettings,
}));

import { renderThumbnail } from "./render-thumbnail";

function setup() {
  const events: string[] = [];
  const assets = {
    dispose: vi.fn(() => events.push("assets.dispose")),
  };
  const scene = { scene: true };
  const gpu = {
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
  const output = { format: "rgba8unorm", size: [160, 90] };
  mocks.readFile.mockResolvedValue(new Uint8Array(48));
  mocks.createAssets.mockReturnValue(assets);
  mocks.createScene.mockResolvedValue(scene);
  mocks.destroyScene.mockImplementation(() => events.push("scene.destroy"));
  mocks.renderScene.mockImplementation(() => events.push("render"));
  return { assets, events, gpu, output };
}

afterEach(() => {
  vi.resetAllMocks();
});

test("renders deterministic frames, drains work, and cleans shared children", async () => {
  const env = setup();
  await renderThumbnail(env.gpu as never, env.output as never, {
    dt: 0.25,
    publicAssetsRoot: "/repo/apps/docs/public",
    time: 2,
    warmupFrames: 3,
  });

  expect(mocks.renderScene).toHaveBeenCalledTimes(3);
  expect(mocks.setSettings.mock.calls.map((call) => call[3].time)).toEqual([
    2, 2.25, 2.5,
  ]);
  expect(env.gpu.gpu.queue.onSubmittedWorkDone).toHaveBeenCalledTimes(2);
  expect(env.gpu.settled).toHaveBeenCalledTimes(2);
  expect(env.events.slice(-4)).toEqual([
    "queue",
    "settled",
    "scene.destroy",
    "assets.dispose",
  ]);
});

test("scene creation failure still drains work and releases loaded assets", async () => {
  const env = setup();
  const failure = new Error("scene failed");
  mocks.createScene.mockRejectedValue(failure);
  await expect(
    renderThumbnail(env.gpu as never, env.output as never, {
      publicAssetsRoot: "/repo/apps/docs/public",
    })
  ).rejects.toBe(failure);
  expect(mocks.destroyScene).not.toHaveBeenCalled();
  expect(env.assets.dispose).toHaveBeenCalledTimes(1);
  expect(env.gpu.gpu.queue.onSubmittedWorkDone).toHaveBeenCalledTimes(1);
  expect(env.gpu.settled).toHaveBeenCalledTimes(1);
});

test("cleanup and barrier errors cannot mask the primary render failure", async () => {
  const env = setup();
  const primary = new Error("render failed");
  mocks.renderScene.mockImplementation(() => {
    throw primary;
  });
  mocks.destroyScene.mockImplementation(() => {
    throw new Error("scene cleanup failed");
  });
  env.assets.dispose.mockImplementation(() => {
    throw new Error("asset cleanup failed");
  });
  env.gpu.gpu.queue.onSubmittedWorkDone.mockRejectedValue(
    new Error("queue failed")
  );
  env.gpu.settled.mockRejectedValue(new Error("settled failed"));

  await expect(
    renderThumbnail(env.gpu as never, env.output as never, {
      publicAssetsRoot: "/repo/apps/docs/public",
    })
  ).rejects.toBe(primary);
  expect(mocks.destroyScene).toHaveBeenCalledTimes(1);
  expect(env.assets.dispose).toHaveBeenCalledTimes(1);
});

test("successful rendering reports cleanup failure after all attempts", async () => {
  const env = setup();
  const failure = new Error("scene cleanup failed");
  mocks.destroyScene.mockImplementation(() => {
    throw failure;
  });
  await expect(
    renderThumbnail(env.gpu as never, env.output as never, {
      publicAssetsRoot: "/repo/apps/docs/public",
    })
  ).rejects.toBe(failure);
  expect(env.assets.dispose).toHaveBeenCalledTimes(1);
});

test("requires an absolute asset root before allocating GPU children", async () => {
  const env = setup();
  await expect(
    renderThumbnail(env.gpu as never, env.output as never, {
      publicAssetsRoot: "relative/public",
    })
  ).rejects.toThrow("absolute path");
  expect(mocks.createAssets).not.toHaveBeenCalled();
});
