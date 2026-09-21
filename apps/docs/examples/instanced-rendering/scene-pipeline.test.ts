import { createHash } from "node:crypto";

import { afterEach, expect, test, vi } from "vitest";

const api = vi.hoisted(() => ({
  bundle: vi.fn(),
  draw: vi.fn(),
  effect: vi.fn(),
  geometry: vi.fn(),
  sampler: vi.fn(),
  perspectiveCamera: vi.fn(),
}));

vi.mock("vgpu", () => ({
  bundle: api.bundle,
  draw: api.draw,
  effect: api.effect,
  geometry: api.geometry,
  sampler: api.sampler,
}));
vi.mock("vgpu/scene", () => ({ perspectiveCamera: api.perspectiveCamera }));

import {
  createBlit,
  createScene,
  DEFAULT_INSTANCE_COUNT,
  INSTANCE_COUNT_OPTIONS,
  isInstanceCount,
  renderScene,
} from "./scene-pipeline";

function setup() {
  const geometries: Array<{ destroy: ReturnType<typeof vi.fn> }> = [];
  const draws: Array<{
    set: ReturnType<typeof vi.fn>;
    compile: ReturnType<typeof vi.fn>;
  }> = [];
  const bundleDraw = vi.fn();
  const recorded = { id: "recorded-bundle" };
  const matrix = new Float32Array(16).fill(3);

  api.geometry.mockImplementation(() => {
    const value = { destroy: vi.fn() };
    geometries.push(value);
    return value;
  });
  api.draw.mockImplementation(() => {
    const value = { set: vi.fn(), compile: vi.fn(async () => {}) };
    draws.push(value);
    return value;
  });
  api.bundle.mockImplementation(
    (
      _gpu: unknown,
      _options: unknown,
      record: (pass: { draw: typeof bundleDraw }) => void
    ) => {
      record({ draw: bundleDraw });
      return recorded;
    }
  );
  api.perspectiveCamera.mockReturnValue({ viewProjection: matrix });

  return { bundleDraw, draws, geometries, matrix, recorded };
}

afterEach(() => {
  for (const mock of Object.values(api)) mock.mockReset();
});

test("defines only the exact default and opt-in instance counts", () => {
  expect(DEFAULT_INSTANCE_COUNT).toBe(50);
  expect(INSTANCE_COUNT_OPTIONS).toEqual({
    "50³ (125k)": 50,
    "100³ (1M — stress test)": 100,
  });
  expect([49, 50, 75, 100, 101].filter(isInstanceCount)).toEqual([50, 100]);
});

test.each([
  {
    count: 50 as const,
    instances: 125_000,
    extent: 32,
    hash: "298bf7303c240150d7332bcfca22d55e5667367d18df0a48585534195664ef90",
    first: [
      -15.680000305175781, -15.680000305175781, -15.680000305175781,
      0.07999999821186066, 0.7134765386581421, 1, 0.3183631896972656,
    ],
    last: [
      15.680000305175781, 15.680000305175781, 15.680000305175781, 1,
      0.11999999731779099, 0.7918164134025574, 0.13453803956508636,
    ],
  },
  {
    count: 100 as const,
    instances: 1_000_000,
    extent: 64,
    hash: "18b887422ad8f5a96b463424c5176e46fd452d9af9cec5332ef9f66284f964c1",
    first: [
      -31.68000030517578, -31.68000030517578, -31.68000030517578,
      0.07999999821186066, 0.7134765386581421, 1, 0.3183631896972656,
    ],
    last: [
      31.68000030517578, 31.68000030517578, 31.68000030517578,
      0.07999999821186066, 0.7744140625, 1, 0.24547746777534485,
    ],
  },
])(
  "builds one cube mesh, one $instances-instance stream, and one bundle",
  async ({ count, instances, extent, hash, first, last }) => {
    const env = setup();
    const gpu = { id: "gpu" } as never;
    const target = { id: "target" } as never;
    const scene = await createScene(gpu, target, count);

    expect(api.geometry).toHaveBeenCalledOnce();
    const options = api.geometry.mock.calls[0]![1] as {
      label: string;
      buffers: Array<{
        data: ArrayBuffer;
        stride: number;
        stepMode?: string;
        attributes: Record<string, string>;
      }>;
    };
    expect(options.label).toBe(`instanced-cubes-${count}`);
    expect(options.buffers).toHaveLength(2);
    expect(
      options.buffers.filter((buffer) => buffer.stepMode === "instance")
    ).toHaveLength(1);
    expect(options.buffers[0]).toMatchObject({
      stride: 24,
      attributes: { local_position: "float32x3", local_normal: "float32x3" },
    });
    expect(options.buffers[0]!.data.byteLength).toBe(36 * 6 * 4);
    expect(
      createHash("sha256")
        .update(new Uint8Array(options.buffers[0]!.data))
        .digest("hex")
    ).toBe("adc473faa86758bca64227cc4d9cfacf3afe8b47cb69f9ffabe76c6bd9b67a14");

    const instanceBuffer = options.buffers[1]!;
    expect(instanceBuffer).toMatchObject({
      stride: 28,
      stepMode: "instance",
      attributes: {
        i_position: "float32x3",
        i_color: "float32x3",
        i_seed: "float32",
      },
    });
    expect(instanceBuffer.data.byteLength).toBe(instances * 28);
    expect(
      createHash("sha256")
        .update(new Uint8Array(instanceBuffer.data))
        .digest("hex")
    ).toBe(hash);
    const values = new Float32Array(instanceBuffer.data);
    expect([...values.slice(0, 7)]).toEqual(first);
    expect([...values.slice(-7)]).toEqual(last);

    expect(api.draw).toHaveBeenCalledOnce();
    expect(env.draws[0]!.compile).toHaveBeenCalledWith(target);
    expect(api.bundle).toHaveBeenCalledOnce();
    expect(env.bundleDraw).toHaveBeenCalledOnce();
    expect(env.bundleDraw).toHaveBeenCalledWith(env.draws[0]);
    expect(scene).toEqual({
      geometry: env.geometries[0],
      draw: env.draws[0],
      bundle: env.recorded,
      extent,
    });
  }
);

test("reuses the recorded bundle every frame and preserves the camera arithmetic", async () => {
  const env = setup();
  const colorTarget = { size: [640, 360] } as never;
  const output = { size: [800, 400] } as never;
  const scene = await createScene({} as never, colorTarget, 50);
  const blit = { id: "blit" } as never;
  const passRecords: Array<{
    options: unknown;
    bundles: ReturnType<typeof vi.fn>;
    draw: ReturnType<typeof vi.fn>;
  }> = [];
  const frame = {
    pass: vi.fn((options: unknown, record: (pass: unknown) => void) => {
      const pass = { options, bundles: vi.fn(), draw: vi.fn() };
      passRecords.push(pass);
      record(pass);
    }),
  } as never;

  renderScene(frame, scene, blit, colorTarget, output, 2.4);
  renderScene(frame, scene, blit, colorTarget, output, 18);

  expect(api.bundle).toHaveBeenCalledOnce();
  expect(passRecords).toHaveLength(4);
  expect(passRecords[0]!.bundles).toHaveBeenCalledWith(env.recorded);
  expect(passRecords[1]!.draw).toHaveBeenCalledWith(blit);
  expect(passRecords[2]!.bundles).toHaveBeenCalledWith(env.recorded);
  expect(passRecords[3]!.draw).toHaveBeenCalledWith(blit);
  expect(passRecords[0]!.options).toEqual({
    target: colorTarget,
    clear: [0.008, 0.014, 0.035, 1],
  });
  expect(api.perspectiveCamera).toHaveBeenNthCalledWith(1, {
    fov: 42,
    aspect: 2,
    near: 0.1,
    far: 198.4,
    position: [
      Math.cos(2.4 * 0.06 + 0.55) * 49.6,
      49.6 * 0.62,
      Math.sin(2.4 * 0.06 + 0.55) * 49.6,
    ],
    target: [0, 0, 0],
  });
  expect(env.draws[0]!.set).toHaveBeenLastCalledWith({
    time: 18,
    viewProjection: env.matrix,
  });
});

test.each(["draw", "compile", "bundle"] as const)(
  "destroys partial geometry and preserves a %s failure",
  async (stage) => {
    const env = setup();
    const primary = new Error(`${stage} failed`);
    const cleanup = new Error("cleanup failed");
    env.geometries.length = 0;
    api.geometry.mockImplementationOnce(() => {
      const geometry = {
        destroy: vi.fn(() => {
          throw cleanup;
        }),
      };
      env.geometries.push(geometry);
      return geometry;
    });
    if (stage === "draw")
      api.draw.mockImplementationOnce(() => {
        throw primary;
      });
    if (stage === "compile") {
      api.draw.mockImplementationOnce(() => ({
        set: vi.fn(),
        compile: vi.fn(() => {
          throw primary;
        }),
      }));
    }
    if (stage === "bundle")
      api.bundle.mockImplementationOnce(() => {
        throw primary;
      });

    await expect(createScene({} as never, {} as never, 50)).rejects.toBe(
      primary
    );
    expect(env.geometries[0]!.destroy).toHaveBeenCalledOnce();
  }
);

test("binds the offscreen texture, resolution, and one linear sampler in the blit", () => {
  const set = vi.fn();
  const blit = { set };
  const linearSampler = { id: "linear" };
  api.effect.mockReturnValueOnce(blit);
  api.sampler.mockReturnValueOnce(linearSampler);
  const gpu = { id: "gpu" } as never;
  const source = { id: "source" } as never;
  const output = { size: [320, 180] } as never;

  expect(createBlit(gpu, source, output)).toBe(blit);
  expect(api.effect).toHaveBeenCalledOnce();
  expect(api.sampler).toHaveBeenCalledWith(gpu, {
    minFilter: "linear",
    magFilter: "linear",
  });
  expect(set).toHaveBeenCalledWith({
    linear_samp: linearSampler,
    scene_tex: source,
    resolution: [320, 180],
  });
});
