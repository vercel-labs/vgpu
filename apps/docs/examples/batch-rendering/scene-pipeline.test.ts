import { expect, test, vi } from "vitest";

const camera = vi.hoisted(() =>
  vi.fn(() => ({ viewProjection: new Float32Array(16) }))
);
const vgpuFns = vi.hoisted(() =>
  Object.fromEntries(
    ["bundle", "draw", "effect", "geometry", "sampler"].map((name) => [
      name,
      (gpu: any, ...args: any[]) => gpu.fns[name](...args),
    ])
  )
) as Record<string, unknown>;

vi.mock("vgpu", () => vgpuFns);
vi.mock("vgpu/scene", () => ({ perspectiveCamera: camera }));

import { createScene, renderScene } from "./scene-pipeline";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function setup() {
  const slices: Record<string, unknown>[] = [];
  const geometry = {
    slice: vi.fn((options: Record<string, unknown>) => {
      const slice = { ...options };
      slices.push(slice);
      return slice;
    }),
    destroy: vi.fn(),
  };
  const draws = Array.from({ length: 4 }, () => ({
    set: vi.fn(),
    compile: vi.fn(async () => undefined),
  }));
  const bundleDraw = vi.fn();
  const recorded = { id: "recorded", gpu: {} };
  const gpu = {
    fns: {
      geometry: vi.fn((_options: unknown) => geometry),
      draw: vi.fn(
        (_options: unknown) => draws[gpu.fns.draw.mock.calls.length - 1]
      ),
      bundle: vi.fn(
        (
          _options: unknown,
          record: (recorder: { draw: typeof bundleDraw }) => void
        ) => {
          record({ draw: bundleDraw });
          return recorded;
        }
      ),
      effect: vi.fn(() => ({ set: vi.fn() })),
      sampler: vi.fn(() => ({})),
    },
  };
  const target = { size: [480, 270], format: "rgba8unorm" };
  return { gpu, target, geometry, slices, draws, bundleDraw, recorded };
}

test("packs four contiguous primitive ranges into one mesh and records one bundle", async () => {
  const env = setup();
  const scene = await createScene(env.gpu as never, env.target as never);

  const descriptor = env.gpu.fns.geometry.mock.calls[0]![0] as any;
  expect(descriptor.label).toBe("batch-rendering-packed-primitives");
  expect(descriptor.buffers[0].stride).toBe(36);
  expect(descriptor.buffers[0].data).toBeInstanceOf(Float32Array);
  expect(descriptor.buffers[0].data).toHaveLength(141_312 * 9);
  expect(env.geometry.slice.mock.calls.map(([range]) => range)).toEqual([
    { firstVertex: 0, vertexCount: 36_864, label: "cubes" },
    { firstVertex: 36_864, vertexCount: 18_432, label: "pyramids" },
    { firstVertex: 55_296, vertexCount: 24_576, label: "octahedra" },
    { firstVertex: 79_872, vertexCount: 61_440, label: "icosahedra" },
  ]);
  expect(env.gpu.fns.draw).toHaveBeenCalledTimes(4);
  expect(env.draws.every((draw) => draw.compile.mock.calls.length === 1)).toBe(
    true
  );
  expect(env.gpu.fns.bundle).toHaveBeenCalledOnce();
  expect(env.bundleDraw.mock.calls.map(([drawable]) => drawable)).toEqual(
    env.draws
  );
  expect(scene.bundle).toBe(env.recorded);
});

test("reuses the recorded bundle in the offscreen then blit pass order", async () => {
  const env = setup();
  const scene = await createScene(env.gpu as never, env.target as never);
  const blit = { id: "blit" };
  const output = { size: [480, 270], format: "bgra8unorm" };
  const passes: {
    options: unknown;
    bundles: ReturnType<typeof vi.fn>;
    draw: ReturnType<typeof vi.fn>;
  }[] = [];
  const currentFrame = {
    pass: vi.fn((options: unknown, encode: (pass: any) => void) => {
      const pass = { bundles: vi.fn(), draw: vi.fn() };
      passes.push({ options, ...pass });
      encode(pass);
    }),
  };

  renderScene(
    currentFrame as never,
    scene,
    blit as never,
    env.target as never,
    output as never,
    2.4
  );
  renderScene(
    currentFrame as never,
    scene,
    blit as never,
    env.target as never,
    output as never,
    18
  );

  expect(env.gpu.fns.bundle).toHaveBeenCalledOnce();
  expect(passes.map((pass) => pass.options)).toEqual([
    { target: env.target, clear: [0.008, 0.014, 0.035, 1] },
    { target: output },
    { target: env.target, clear: [0.008, 0.014, 0.035, 1] },
    { target: output },
  ]);
  expect(passes[0]?.bundles).toHaveBeenCalledWith(scene.bundle);
  expect(passes[2]?.bundles).toHaveBeenCalledWith(scene.bundle);
  expect(passes[1]?.draw).toHaveBeenCalledWith(blit);
  expect(passes[3]?.draw).toHaveBeenCalledWith(blit);
  expect(env.draws.every((draw) => draw.set.mock.calls.length === 3)).toBe(
    true
  );
});

test("waits for every compile before rolling back the first asynchronous failure", async () => {
  const env = setup();
  const failed = new Error("compile failed");
  const pending = env.draws.map(() => deferred<undefined>());
  env.draws.forEach((draw, index) =>
    draw.compile.mockReturnValueOnce(pending[index]!.promise)
  );

  const creating = createScene(env.gpu as never, env.target as never);
  await vi.waitFor(() =>
    expect(
      env.draws.every((draw) => draw.compile.mock.calls.length === 1)
    ).toBe(true)
  );
  pending[1]!.reject(failed);
  pending[0]!.resolve(undefined);
  pending[2]!.resolve(undefined);
  expect(env.geometry.destroy).not.toHaveBeenCalled();
  pending[3]!.resolve(undefined);

  await expect(creating).rejects.toBe(failed);
  expect(env.geometry.destroy).toHaveBeenCalledOnce();
  expect(env.gpu.fns.bundle).not.toHaveBeenCalled();
});

test("promise-wraps synchronous compile throws and still attempts every draw", async () => {
  const env = setup();
  const failed = new Error("synchronous compile failed");
  env.draws[0]!.compile.mockImplementationOnce(() => {
    throw failed;
  });

  await expect(createScene(env.gpu as never, env.target as never)).rejects.toBe(
    failed
  );
  expect(env.draws.every((draw) => draw.compile.mock.calls.length === 1)).toBe(
    true
  );
  expect(env.geometry.destroy).toHaveBeenCalledOnce();
});

test("preserves the compile failure when geometry cleanup also throws", async () => {
  const env = setup();
  const failed = new Error("compile failed");
  env.draws[0]!.compile.mockRejectedValueOnce(failed);
  env.geometry.destroy.mockImplementationOnce(() => {
    throw new Error("cleanup failed");
  });

  await expect(createScene(env.gpu as never, env.target as never)).rejects.toBe(
    failed
  );
  expect(env.geometry.destroy).toHaveBeenCalledOnce();
});

test("destroys the captured geometry when bundle recording fails", async () => {
  const env = setup();
  const failed = new Error("bundle failed");
  env.gpu.fns.bundle.mockImplementationOnce(() => {
    throw failed;
  });

  await expect(createScene(env.gpu as never, env.target as never)).rejects.toBe(
    failed
  );
  expect(env.geometry.destroy).toHaveBeenCalledOnce();
});
