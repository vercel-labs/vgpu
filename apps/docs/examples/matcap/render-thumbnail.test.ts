import { afterEach, expect, test, vi } from "vitest";

const sceneFns = vi.hoisted(() => ({
  createScene: vi.fn(),
  renderScene: vi.fn(),
}));
const vgpuFns = vi.hoisted(() => ({
  frame: (gpu: any, ...args: any[]) => gpu.fns.frame(...args),
}));

vi.mock("vgpu", () => vgpuFns);
vi.mock("./scene", () => sceneFns);

import { renderThumbnail } from "./render-thumbnail";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function setup() {
  const scene = { solid: {} };
  sceneFns.createScene.mockReturnValue(scene);
  const queue = vi.fn((): Promise<void> => Promise.resolve());
  const settled = vi.fn((): Promise<void> => Promise.resolve());
  const gpu = {
    gpu: { queue: { onSubmittedWorkDone: queue } },
    settled,
    fns: {
      frame: vi.fn((render: (frame: unknown) => void) => render({ id: "frame" })),
    },
  };
  const output = { size: [320, 180] };
  return { scene, queue, settled, gpu, output };
}

afterEach(() => vi.resetAllMocks());

test("preserves default, custom, and explicit-zero thumbnail times", async () => {
  const env = setup();
  await renderThumbnail(env.gpu as never, env.output as never);
  await renderThumbnail(env.gpu as never, env.output as never, { time: 7.25 });
  await renderThumbnail(env.gpu as never, env.output as never, { time: 0 });

  expect(sceneFns.renderScene.mock.calls.map((call) => call[3])).toEqual([
    3.1, 7.25, 0,
  ]);
});

test("waits for both GPU completion barriers", async () => {
  const env = setup();
  const queue = deferred();
  const settled = deferred();
  env.queue.mockReturnValueOnce(queue.promise);
  env.settled.mockReturnValueOnce(settled.promise);

  const rendering = renderThumbnail(env.gpu as never, env.output as never);
  await vi.waitFor(() => {
    expect(env.queue).toHaveBeenCalledOnce();
    expect(env.settled).toHaveBeenCalledOnce();
  });
  queue.resolve();
  await Promise.resolve();
  let completed = false;
  void rendering.then(() => {
    completed = true;
  });
  await Promise.resolve();
  expect(completed).toBe(false);
  settled.resolve();
  await expect(rendering).resolves.toBeUndefined();
});

test("preserves the render failure across barrier failures", async () => {
  const env = setup();
  const failure = new Error("render failed");
  env.gpu.fns.frame.mockImplementationOnce(() => {
    throw failure;
  });
  env.queue.mockRejectedValueOnce(new Error("queue failed"));
  env.settled.mockRejectedValueOnce(new Error("settled failed"));

  await expect(
    renderThumbnail(env.gpu as never, env.output as never)
  ).rejects.toBe(failure);
  expect(env.queue).toHaveBeenCalledOnce();
  expect(env.settled).toHaveBeenCalledOnce();
});

test("propagates a settled failure after successful rendering", async () => {
  const env = setup();
  const failure = new Error("settled failed");
  env.settled.mockRejectedValueOnce(failure);

  await expect(
    renderThumbnail(env.gpu as never, env.output as never)
  ).rejects.toBe(failure);
});
