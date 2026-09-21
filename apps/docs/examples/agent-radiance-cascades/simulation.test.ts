import { afterEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  effect: vi.fn(() => ({ compile: vi.fn(), set: vi.fn() })),
  frame: vi.fn(),
  sampler: vi.fn(() => ({})),
  target: vi.fn(),
}));

vi.mock("vgpu", () => mocks);

import {
  createScene,
  destroyScene,
  presentScene,
  renderLighting,
} from "./simulation";

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

test("computes responsive cascade and quality atlas dimensions", () => {
  setupTargets();
  expect(createScene({} as never, [640, 360], 2)).toMatchObject({
    size: [640, 360],
    cascadeCount: 6,
    atlas: [1280, 768],
    directionBase: 2,
  });
  expect(createScene({} as never, [320, 568], 2)).toMatchObject({
    cascadeCount: 5,
    atlas: [640, 1152],
  });
  expect(createScene({} as never, [800, 450], 3)).toMatchObject({
    cascadeCount: 6,
    atlas: [2400, 1440],
    directionBase: 3,
  });
});

test("scene allocation rolls back partial targets and preserves its error", () => {
  const targets = setupTargets();
  const failure = new Error("target failed");
  const allocate = mocks.target.getMockImplementation()!;
  let calls = 0;
  mocks.target.mockImplementation(() => {
    if (++calls === 4) throw failure;
    const value = allocate();
    if (calls === 1)
      value.destroy.mockImplementation(() => {
        throw new Error("cleanup failed");
      });
    return value;
  });
  expect(() => createScene({} as never, [160, 90])).toThrow(failure);
  expect(targets).toHaveLength(3);
  for (const resource of targets)
    expect(resource.destroy).toHaveBeenCalledOnce();
});

test("effect allocation failure rolls back every shared-GPU target", () => {
  const targets = setupTargets();
  const failure = new Error("effect failed");
  mocks.effect.mockImplementationOnce(() => {
    throw failure;
  });
  expect(() => createScene({} as never, [160, 90])).toThrow(failure);
  expect(targets).toHaveLength(6);
  for (const resource of targets)
    expect(resource.destroy).toHaveBeenCalledOnce();
});

test("scene destruction attempts every target and reports the first failure", () => {
  const targets = setupTargets();
  const scene = createScene({} as never, [160, 90]);
  const failure = new Error("cascade cleanup failed");
  targets[5]!.destroy.mockImplementation(() => {
    throw failure;
  });
  targets[0]!.destroy.mockImplementation(() => {
    throw new Error("later failure");
  });
  expect(() => destroyScene(scene)).toThrow(failure);
  for (const resource of targets)
    expect(resource.destroy).toHaveBeenCalledOnce();
});

test("debug views stop after the last resource they display", () => {
  setupTargets();
  const passes: unknown[] = [];
  mocks.frame.mockImplementation((_gpu, encode) => {
    encode({ pass: vi.fn((options: unknown) => passes.push(options)) });
  });
  const scene = createScene({} as never, [160, 90]);
  renderLighting(scene, 1.5, "emitters");
  expect(passes).toHaveLength(1);
  passes.length = 0;
  renderLighting(scene, 1.5, "jfa");
  expect(passes).toHaveLength(2 + scene.jumps.length);
  passes.length = 0;
  renderLighting(scene, 1.5, "sdf");
  expect(passes).toHaveLength(3 + scene.jumps.length);
  passes.length = 0;
  renderLighting(scene, 1.5, "cascade-4");
  expect(passes).toHaveLength(4 + scene.jumps.length);
});

test("present maps JFA and bounded cascade views to their shader modes", () => {
  setupTargets();
  mocks.frame.mockImplementation((_gpu, encode) => {
    encode({ pass: vi.fn() });
  });
  const scene = createScene({} as never, [320, 568]);
  presentScene(scene, {} as never, "jfa");
  expect(scene.effects.present.set).toHaveBeenLastCalledWith(
    expect.objectContaining({
      present: expect.objectContaining({ display: [0.92, 4, 48, 2] }),
    })
  );
  presentScene(scene, {} as never, "cascade-5");
  expect(scene.effects.present.set).toHaveBeenLastCalledWith(
    expect.objectContaining({
      present: expect.objectContaining({ display: [0.92, 3, 48, 2] }),
    })
  );
});
