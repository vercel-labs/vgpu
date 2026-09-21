import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createChart: vi.fn(),
  createLogits: vi.fn(),
  writeLogits: vi.fn(),
}));

vi.mock("./renderer", () => ({
  createChart: mocks.createChart,
  createLogitsBuffer: mocks.createLogits,
  writeLogits: mocks.writeLogits,
}));

import { renderThumbnail } from "./render-thumbnail";

function setup(
  options: { submittedError?: unknown; settledError?: unknown } = {}
) {
  const order: string[] = [];
  const chart = vi.fn(() => order.push("draw"));
  const logits = {
    dispose: vi.fn(() => order.push("dispose")),
  };
  mocks.createChart.mockReturnValue(chart);
  mocks.createLogits.mockReturnValue(logits);
  const submitted = vi.fn(async () => {
    order.push("submitted");
    if (options.submittedError) throw options.submittedError;
  });
  const settled = vi.fn(async () => {
    order.push("settled");
    if (options.settledError) throw options.settledError;
  });
  const gpu = {
    gpu: { queue: { onSubmittedWorkDone: submitted } },
    settled,
    dispose: vi.fn(),
  };
  return { chart, gpu, logits, order, settled, submitted, target: {} };
}

describe("MNIST thumbnail ownership", () => {
  beforeEach(() => vi.resetAllMocks());

  it("waits both barriers, disposes its buffer, and retains the shared GPU", async () => {
    const env = setup();
    await renderThumbnail(env.gpu as never, env.target as never);
    expect(env.order).toEqual(["draw", "submitted", "settled", "dispose"]);
    expect(env.gpu.dispose).not.toHaveBeenCalled();
  });

  it("runs both barriers after partial construction", async () => {
    const primary = new Error("buffer allocation failed");
    const env = setup();
    mocks.createLogits.mockImplementation(() => {
      throw primary;
    });
    await expect(
      renderThumbnail(env.gpu as never, env.target as never)
    ).rejects.toBe(primary);
    expect(env.submitted).toHaveBeenCalledOnce();
    expect(env.settled).toHaveBeenCalledOnce();
  });

  it("preserves the draw failure through barrier and cleanup failures", async () => {
    const primary = new Error("draw failed");
    const env = setup({
      submittedError: new Error("submitted failed"),
      settledError: new Error("settled failed"),
    });
    env.chart.mockImplementation(() => {
      throw primary;
    });
    env.logits.dispose.mockImplementation(() => {
      throw new Error("dispose failed");
    });
    await expect(
      renderThumbnail(env.gpu as never, env.target as never)
    ).rejects.toBe(primary);
    expect(env.submitted).toHaveBeenCalledOnce();
    expect(env.settled).toHaveBeenCalledOnce();
    expect(env.logits.dispose).toHaveBeenCalledOnce();
  });

  it("exposes the first barrier failure when rendering succeeds", async () => {
    const primary = new Error("submitted failed");
    const env = setup({
      submittedError: primary,
      settledError: new Error("settled failed"),
    });
    await expect(
      renderThumbnail(env.gpu as never, env.target as never)
    ).rejects.toBe(primary);
    expect(env.logits.dispose).toHaveBeenCalledOnce();
  });
});
