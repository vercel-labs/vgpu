import { afterEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  effect: vi.fn(() => ({ compile: vi.fn(), set: vi.fn() })),
  frame: vi.fn(),
  sampler: vi.fn(() => ({})),
  target: vi.fn(),
}));

vi.mock("vgpu", () => mocks);

import { createScene, destroyScene } from "./simulation";

function setupTargets() {
  const targets: Array<{ destroy: ReturnType<typeof vi.fn> }> = [];
  mocks.target.mockImplementation(() => {
    const value = { destroy: vi.fn() };
    targets.push(value);
    return value;
  });
  return targets;
}

afterEach(() => {
  vi.resetAllMocks();
});

test("scene allocation rolls back every partial target and preserves its error", () => {
  const targets = setupTargets();
  const failure = new Error("target failed");
  const cleanupFailure = new Error("cleanup failed");
  const allocate = mocks.target.getMockImplementation()!;
  let calls = 0;
  mocks.target.mockImplementation(() => {
    if (++calls === 4) throw failure;
    const value = allocate();
    if (calls === 1)
      value.destroy.mockImplementation(() => {
        throw cleanupFailure;
      });
    return value;
  });

  expect(() => createScene({} as never, [160, 90])).toThrow(failure);
  expect(targets).toHaveLength(3);
  for (const resource of targets) {
    expect(resource.destroy).toHaveBeenCalledOnce();
  }
});

test("effect allocation failure rolls back all shared-GPU targets", () => {
  const targets = setupTargets();
  const failure = new Error("effect failed");
  mocks.effect.mockImplementationOnce(() => {
    throw failure;
  });

  expect(() => createScene({} as never, [160, 90])).toThrow(failure);
  expect(targets).toHaveLength(7);
  for (const resource of targets) {
    expect(resource.destroy).toHaveBeenCalledOnce();
  }
});

test("scene destruction attempts every target and reports the first failure", () => {
  const targets = setupTargets();
  const scene = createScene({} as never, [160, 90]);
  const failure = new Error("cascade cleanup failed");
  const laterFailure = new Error("emitter cleanup failed");
  targets[6]!.destroy.mockImplementation(() => {
    throw failure;
  });
  targets[0]!.destroy.mockImplementation(() => {
    throw laterFailure;
  });

  expect(() => destroyScene(scene)).toThrow(failure);
  for (const resource of targets) {
    expect(resource.destroy).toHaveBeenCalledOnce();
  }
});
