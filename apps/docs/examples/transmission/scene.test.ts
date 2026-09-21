import { afterEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  draw: vi.fn(),
  effect: vi.fn(),
  frame: vi.fn(),
  geometry: vi.fn(),
  sampler: vi.fn(),
  target: vi.fn(),
}));

vi.mock("vgpu", () => mocks);
vi.mock("vgpu/scene", () => ({
  box: vi.fn(),
  perspectiveCamera: vi.fn(),
  plane: vi.fn(),
}));

import {
  createTargets,
  destroyScene,
  normalizeControls,
  renderScene,
  replaceTargets,
} from "./scene";

function texture(name: string, events: string[] = []) {
  return {
    destroy: vi.fn(() => events.push(name)),
    gpu: { name },
  };
}

function colorTarget(
  name: string,
  size: readonly [number, number] = [1, 1],
  events: string[] = []
) {
  return {
    color: { gpu: { name } },
    destroy: vi.fn(() => events.push(name)),
    size,
  };
}

afterEach(() => {
  vi.resetAllMocks();
});

test("normalizes all public controls", () => {
  expect(
    normalizeControls({
      dispersion: 0 as never,
      ior: Number.NaN,
      refraction: "invalid" as never,
      roughness: Infinity,
    })
  ).toEqual({
    dispersion: false,
    ior: 1.5,
    refraction: "simple",
    roughness: 0.06,
  });
  expect(
    normalizeControls({
      dispersion: true,
      ior: 20,
      refraction: "double",
      roughness: -4,
    })
  ).toEqual({
    dispersion: true,
    ior: 2.4,
    refraction: "double",
    roughness: 0,
  });
});

test("scene destruction attempts every child and reports its first failure", () => {
  const events: string[] = [];
  const env = texture("env", events);
  const cube = texture("cube", events);
  const floor = texture("floor", events);
  const hdr = colorTarget("hdr", [2, 2], events);
  const pyramid = texture("pyramid", events);
  const horizontal = colorTarget("horizontal", [1, 1], events);
  const vertical = colorTarget("vertical", [1, 1], events);
  const primary = new Error("vertical failed");
  vertical.destroy.mockImplementation(() => {
    events.push("vertical");
    throw primary;
  });
  hdr.destroy.mockImplementation(() => {
    events.push("hdr");
    throw new Error("hdr failed");
  });
  const scene = {
    cubeGeometry: cube,
    env,
    floorGeometry: floor,
    targets: { chain: [{ horizontal, vertical }], hdr, pyramid },
  };

  expect(() => destroyScene(scene as never)).toThrow(primary);
  expect(events).toEqual([
    "vertical",
    "horizontal",
    "pyramid",
    "hdr",
    "floor",
    "cube",
    "env",
  ]);
});

test("target construction rolls back without masking its failure", () => {
  const events: string[] = [];
  const hdr = colorTarget("hdr", [2, 2], events);
  const pyramid = texture("pyramid", events);
  const primary = new Error("level failed");
  mocks.target.mockReturnValueOnce(hdr).mockImplementationOnce(() => {
    throw primary;
  });
  const gpu = {
    device: { createTexture: vi.fn(() => pyramid) },
  };

  expect(() => createTargets(gpu as never, [2, 2])).toThrow(primary);
  expect(events).toEqual(["pyramid", "hdr"]);
});

test("target replacement restores bindings and destroys the rejected set", () => {
  const events: string[] = [];
  const previous = {
    chain: [],
    hdr: colorTarget("old-hdr", [1, 1], events),
    pyramid: texture("old-pyramid", events),
  };
  const nextHdr = colorTarget("next-hdr", [1, 1], events);
  const nextPyramid = texture("next-pyramid", events);
  mocks.target.mockReturnValue(nextHdr);
  const gpu = {
    device: { createTexture: vi.fn(() => nextPyramid) },
  };
  const primary = new Error("binding failed");
  const glass = {
    set: vi
      .fn()
      .mockImplementationOnce(() => {
        throw primary;
      })
      .mockImplementation(() => undefined),
  };
  const scene = {
    blurs: [],
    glass,
    present: { set: vi.fn() },
    pyramidSampler: {},
    targets: previous,
  };

  expect(() => replaceTargets(gpu as never, scene as never, [1, 1])).toThrow(
    primary
  );
  expect(scene.targets).toBe(previous);
  expect(glass.set).toHaveBeenCalledTimes(2);
  expect(events).toEqual(["next-pyramid", "next-hdr"]);
});

test("rendering observes a surface resize before encoding its first pass", () => {
  const oldTargets = {
    chain: [],
    hdr: colorTarget("old", [2, 2]),
    pyramid: texture("old-pyramid"),
  };
  const nextTargets = {
    chain: [],
    hdr: colorTarget("next", [3, 3]),
    pyramid: texture("next-pyramid"),
  };
  const passes: unknown[] = [];
  const gpu = {
    gpu: {
      createCommandEncoder: vi.fn(() => ({
        copyTextureToTexture: vi.fn(),
        finish: vi.fn(() => ({})),
      })),
      queue: { submit: vi.fn() },
    },
  };
  const scene = {
    background: { set: vi.fn() },
    blurs: [],
    floor: { set: vi.fn() },
    glass: { set: vi.fn() },
    present: { set: vi.fn() },
    targets: oldTargets,
  };
  const output = { size: [2, 2] as [number, number] };
  let cameraSize: readonly [number, number] | undefined;
  let frameIndex = 0;
  mocks.frame.mockImplementation(
    (_gpu: unknown, encode: (frame: unknown) => void) => {
      if (frameIndex++ === 0) {
        scene.targets = nextTargets;
        output.size = [3, 3];
      }
      encode({
        pass: (options: unknown, draw: (pass: unknown) => void) => {
          passes.push(options);
          draw({ draw: vi.fn() });
        },
      });
    }
  );

  renderScene(
    gpu as never,
    scene as never,
    output as never,
    () => {
      cameraSize = [...output.size];
      return {
        aspect: 1,
        forward: [0, 0, -1],
        position: [0, 0, 4],
        right: [1, 0, 0],
        tanHalfFov: 1,
        up: [0, 1, 0],
        viewProjection: new Float32Array(16),
      };
    },
    {
      dispersion: true,
      ior: 1.5,
      refraction: "double",
      roughness: 0.06,
    }
  );

  expect(passes).toEqual([
    { clear: [0, 0, 0, 1], target: nextTargets.hdr },
    { clear: false, target: nextTargets.hdr },
    { target: output },
  ]);
  expect(cameraSize).toEqual([3, 3]);
  expect(scene.glass.set).toHaveBeenCalledWith({
    glass: expect.objectContaining({ scene_levels: 1 }),
  });
});
