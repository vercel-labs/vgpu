import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createView: vi.fn(),
  createDepth: vi.fn(),
  createColour: vi.fn(),
  writeDepth: vi.fn(),
  writeColour: vi.fn(),
}));

vi.mock("./fixtures", () => ({
  GOLDEN_MODEL_ID: "fastdepth-320x256",
  decodeGoldenDepth: () => new Float32Array([1]),
  decodeGoldenColour: () => new Uint8ClampedArray([1, 2, 3, 4]),
}));
vi.mock("./renderer", () => ({
  getDepthModel: () => ({ id: "fastdepth-320x256" }),
  createSideBySidePipeline: mocks.createView,
  createDepthBuffer: mocks.createDepth,
  createColourBuffer: mocks.createColour,
  writeDepth: mocks.writeDepth,
  writeColour: mocks.writeColour,
}));

import { renderThumbnail } from "./render-thumbnail";

function setup(
  options: { submittedError?: unknown; settledError?: unknown } = {}
) {
  const view = { draw: vi.fn(), dispose: vi.fn() };
  const depth = { dispose: vi.fn() };
  const colour = { dispose: vi.fn() };
  mocks.createView.mockReturnValue(view);
  mocks.createDepth.mockReturnValue(depth);
  mocks.createColour.mockReturnValue(colour);
  const submitted = vi.fn(async () => {
    if (options.submittedError) throw options.submittedError;
  });
  const settled = vi.fn(async () => {
    if (options.settledError) throw options.settledError;
  });
  const gpu = {
    gpu: { queue: { onSubmittedWorkDone: submitted } },
    settled,
  } as never;
  return { gpu, target: {} as never, view, depth, colour, submitted, settled };
}

describe("depth thumbnail ownership", () => {
  beforeEach(() => vi.resetAllMocks());

  it("waits both barriers and releases every child while retaining the shared GPU", async () => {
    const env = setup();
    await renderThumbnail(env.gpu, env.target);
    expect(env.view.draw).toHaveBeenCalledOnce();
    expect(env.submitted).toHaveBeenCalledOnce();
    expect(env.settled).toHaveBeenCalledOnce();
    expect(env.colour.dispose).toHaveBeenCalledOnce();
    expect(env.depth.dispose).toHaveBeenCalledOnce();
    expect(env.view.dispose).toHaveBeenCalledOnce();
  });

  it("rolls back partial construction after both barriers", async () => {
    const primary = new Error("colour allocation failed");
    const env = setup();
    mocks.createColour.mockImplementation(() => {
      throw primary;
    });
    await expect(renderThumbnail(env.gpu, env.target)).rejects.toBe(primary);
    expect(env.submitted).toHaveBeenCalledOnce();
    expect(env.settled).toHaveBeenCalledOnce();
    expect(env.depth.dispose).toHaveBeenCalledOnce();
    expect(env.view.dispose).toHaveBeenCalledOnce();
  });

  it("preserves the draw error while barriers and every cleanup also fail", async () => {
    const primary = new Error("draw failed");
    const env = setup({
      submittedError: new Error("submitted failed"),
      settledError: new Error("settled failed"),
    });
    env.view.draw.mockImplementation(() => {
      throw primary;
    });
    env.colour.dispose.mockImplementation(() => {
      throw new Error("colour cleanup failed");
    });
    env.depth.dispose.mockImplementation(() => {
      throw new Error("depth cleanup failed");
    });
    env.view.dispose.mockImplementation(() => {
      throw new Error("view cleanup failed");
    });
    await expect(renderThumbnail(env.gpu, env.target)).rejects.toBe(primary);
    expect(env.submitted).toHaveBeenCalledOnce();
    expect(env.settled).toHaveBeenCalledOnce();
    expect(env.colour.dispose).toHaveBeenCalledOnce();
    expect(env.depth.dispose).toHaveBeenCalledOnce();
    expect(env.view.dispose).toHaveBeenCalledOnce();
  });
});
