import { readFileSync } from "node:fs";

import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  disk: vi.fn(() => ({ shape: "disk" })),
  draw: vi.fn(),
  geometry: vi.fn(),
  icosphere: vi.fn(() => ({ shape: "icosphere" })),
  perspectiveCamera: vi.fn((_options: any) => ({
    viewProjection: new Float32Array(16),
  })),
}));

vi.mock("vgpu", () => ({ draw: mocks.draw, geometry: mocks.geometry }));
vi.mock("vgpu/scene", () => ({
  disk: mocks.disk,
  icosphere: mocks.icosphere,
  perspectiveCamera: mocks.perspectiveCamera,
}));

import { createScene, destroyScene, renderScene } from "./scene";

function setup() {
  const geometries = [
    { id: "body-geometry", destroy: vi.fn() },
    { id: "cap-geometry", destroy: vi.fn() },
  ];
  const draws = [
    { id: "body", set: vi.fn() },
    { id: "cap", set: vi.fn() },
  ];
  mocks.geometry
    .mockReturnValueOnce(geometries[0])
    .mockReturnValueOnce(geometries[1]);
  mocks.draw.mockReturnValueOnce(draws[0]).mockReturnValueOnce(draws[1]);
  return { gpu: { id: "gpu" }, geometries, draws };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.disk.mockReturnValue({ shape: "disk" });
  mocks.icosphere.mockReturnValue({ shape: "icosphere" });
  mocks.perspectiveCamera.mockImplementation((_options: any) => ({
    viewProjection: new Float32Array(16),
  }));
});

test("builds the exact flat body and fitted disk cap with back-face culling", () => {
  const env = setup();
  const scene = createScene(env.gpu as never);

  expect(mocks.icosphere).toHaveBeenCalledWith({
    radius: 1,
    subdivisions: 4,
    shading: "flat",
  });
  expect(mocks.disk).toHaveBeenCalledWith({ radius: 1, segments: 64 });
  expect(mocks.geometry.mock.calls).toEqual([
    [env.gpu, { shape: "icosphere" }],
    [env.gpu, { shape: "disk" }],
  ]);
  expect(mocks.draw).toHaveBeenCalledTimes(2);
  expect(mocks.draw.mock.calls[0]?.[1]).toMatchObject({
    geometry: env.geometries[0],
    cull: "back",
  });
  expect(mocks.draw.mock.calls[1]?.[1]).toMatchObject({
    geometry: env.geometries[1],
    cull: "back",
  });
  expect(scene).toEqual({
    geometries: env.geometries,
    body: env.draws[0],
    cap: env.draws[1],
  });
});

describe.each([
  ["maximum", Math.PI / (2 * 0.72), 0.54],
  ["minimum", (3 * Math.PI) / (2 * 0.72), -0.38],
])("clip %s", (_phase, time, clip) => {
  test("sets exact body/cap uniforms and preserves their single-pass order", () => {
    const env = setup();
    const scene = createScene(env.gpu as never);
    const output = { size: [800, 450] };
    const draw = vi.fn();
    const currentFrame = {
      pass: vi.fn(
        (_output: unknown, encode: (pass: { draw: typeof draw }) => void) =>
          encode({ draw })
      ),
    };

    renderScene(currentFrame as never, scene, output as never, time);

    expect(mocks.perspectiveCamera).toHaveBeenCalledWith({
      fov: 36,
      aspect: 800 / 450,
      near: 0.1,
      far: 20,
      position: [0, 0, 4.2],
      target: [0, 0, 0],
    });
    expect(env.draws[0].set).toHaveBeenCalledOnce();
    expect(env.draws[1].set).toHaveBeenCalledOnce();
    const bodyUniform = env.draws[0].set.mock.calls[0]?.[0].scene;
    const capUniform = env.draws[1].set.mock.calls[0]?.[0].scene;
    expect(bodyUniform).toMatchObject({ time, cap: 0 });
    expect(capUniform).toMatchObject({ time, cap: 1 });
    expect(bodyUniform.clip).toBeCloseTo(clip, 12);
    expect(capUniform.clip).toBeCloseTo(clip, 12);
    expect(currentFrame.pass).toHaveBeenCalledWith(
      output,
      expect.any(Function)
    );
    expect(draw.mock.calls.map(([drawable]) => drawable)).toEqual(env.draws);
  });
});

test("reads the responsive target aspect on every frame", () => {
  const env = setup();
  const scene = createScene(env.gpu as never);
  const output = { size: [800, 450] };
  const currentFrame = {
    pass: (_output: unknown, encode: (pass: { draw(): void }) => void) =>
      encode({ draw: vi.fn() }),
  };

  renderScene(currentFrame as never, scene, output as never, 0);
  output.size = [390, 844];
  renderScene(currentFrame as never, scene, output as never, 2.4);

  expect(
    mocks.perspectiveCamera.mock.calls.map(([options]) => options.aspect)
  ).toEqual([800 / 450, 390 / 844]);
});

test.each([
  [0, 0],
  [1, 1],
])(
  "rolls back %i captured geometries when allocation index %i fails",
  (failureIndex, captured) => {
    const env = setup();
    const failure = new Error(`geometry ${failureIndex} failed`);
    mocks.geometry.mockReset();
    if (failureIndex === 1)
      mocks.geometry.mockReturnValueOnce(env.geometries[0]);
    mocks.geometry.mockImplementationOnce(() => {
      throw failure;
    });

    expect(() => createScene(env.gpu as never)).toThrow(failure);
    expect(env.geometries[0].destroy).toHaveBeenCalledTimes(captured);
    expect(env.geometries[1].destroy).not.toHaveBeenCalled();
    expect(mocks.draw).not.toHaveBeenCalled();
  }
);

test.each([0, 1])(
  "rolls back both geometries when draw construction fails at index %i",
  (failureIndex) => {
    const env = setup();
    const failure = new Error(`draw ${failureIndex} failed`);
    mocks.draw.mockReset();
    if (failureIndex === 1) mocks.draw.mockReturnValueOnce(env.draws[0]);
    mocks.draw.mockImplementationOnce(() => {
      throw failure;
    });
    env.geometries[0].destroy.mockImplementationOnce(() => {
      throw new Error("first geometry cleanup failed");
    });

    expect(() => createScene(env.gpu as never)).toThrow(failure);
    expect(env.geometries[0].destroy).toHaveBeenCalledOnce();
    expect(env.geometries[1].destroy).toHaveBeenCalledOnce();
  }
);

test("destroys every geometry and reports the first cleanup failure", () => {
  const env = setup();
  const scene = createScene(env.gpu as never);
  const failure = new Error("body cleanup failed");
  env.geometries[0].destroy.mockImplementationOnce(() => {
    throw failure;
  });
  env.geometries[1].destroy.mockImplementationOnce(() => {
    throw new Error("cap cleanup failed");
  });

  expect(() => destroyScene(scene)).toThrow(failure);
  expect(env.geometries[0].destroy).toHaveBeenCalledOnce();
  expect(env.geometries[1].destroy).toHaveBeenCalledOnce();
});

test("keeps the signed-distance slice and fitted disk cap shader contract", () => {
  const shader = readFileSync(
    new URL("./clipped.wgsl", import.meta.url),
    "utf8"
  );
  expect(shader).toContain("if (scene.cap < 0.5 && in.local.y > scene.clip)");
  expect(shader).toContain(
    "let radius = sqrt(max(0.0, 1.0 - scene.clip * scene.clip));"
  );
  expect(shader).toContain("local = vec3f(position.x * radius, scene.clip");
  expect(shader).toContain("grid_line(in.local.x * 5.0)");
  expect(shader).toContain("abs(in.local.y - scene.clip)");
});
