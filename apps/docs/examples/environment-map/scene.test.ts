import { beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  box: vi.fn(),
  draw: vi.fn(),
  effect: vi.fn(),
  frame: vi.fn(),
  geometry: vi.fn(),
  sampler: vi.fn(),
  target: vi.fn(),
}));

vi.mock("vgpu", () => ({
  draw: mocks.draw,
  effect: mocks.effect,
  frame: mocks.frame,
  geometry: mocks.geometry,
  sampler: mocks.sampler,
  target: mocks.target,
}));
vi.mock("vgpu/scene", () => ({
  box: mocks.box,
  perspectiveCamera: vi.fn(() => ({
    viewProjection: new Float32Array(16),
  })),
}));
vi.mock("./blur.wgsl", () => ({ default: "blur" }));
vi.mock("./metal.wgsl", () => ({ default: "metal" }));
vi.mock("./present.wgsl", () => ({ default: "present" }));
vi.mock("./sky.wgsl", () => ({ default: "sky" }));

import { cameraView } from "./camera";
import { createScene, destroyScene, render, replaceHdr } from "./scene";

interface TrackedResource {
  readonly destroy: ReturnType<typeof vi.fn>;
  readonly gpu: { readonly name: string };
  readonly name: string;
}

function tracked(name: string, events: string[]): TrackedResource {
  return {
    destroy: vi.fn(() => events.push(`destroy:${name}`)),
    gpu: { name },
    name,
  };
}

function targetResource(
  name: string,
  size: readonly [number, number],
  format: GPUTextureFormat,
  events: string[]
) {
  const resource = tracked(name, events);
  return {
    ...resource,
    color: { gpu: { name: `${name}:color` } },
    format,
    size,
  };
}

function shaderResource(name: string, events: string[]) {
  return {
    compile: vi.fn(async () => {
      events.push(`compile:${name}`);
    }),
    name,
    set: vi.fn(() => events.push(`set:${name}`)),
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function setup() {
  const events: string[] = [];
  const targets: ReturnType<typeof targetResource>[] = [];
  const copies: Array<{
    destination: unknown;
    size: readonly number[];
    source: unknown;
  }> = [];
  const encoder = {
    copyTextureToTexture: vi.fn(
      (source: unknown, destination: unknown, size: readonly number[]) => {
        copies.push({ destination, size, source });
      }
    ),
    finish: vi.fn(() => ({ command: true })),
  };
  const env = tracked("env", events);
  const geometry = tracked("geometry", events);
  const cube = shaderResource("cube", events);
  const effects = {
    blur: shaderResource("blur", events),
    present: shaderResource("present", events),
    sky: shaderResource("sky", events),
  };
  const gpu = {
    device: {
      createTexture: vi.fn(() => env),
    },
    gpu: {
      createCommandEncoder: vi.fn(() => encoder),
      queue: { submit: vi.fn(() => events.push("submit")) },
    },
  };
  let targetIndex = 0;
  mocks.target.mockImplementation(
    (
      _gpu: unknown,
      options: { format: GPUTextureFormat; size: [number, number] }
    ) => {
      const value = targetResource(
        `target-${targetIndex++}`,
        options.size,
        options.format,
        events
      );
      targets.push(value);
      return value;
    }
  );
  mocks.sampler.mockImplementation(() => ({ sampler: true }));
  mocks.box.mockReturnValue({ box: true });
  mocks.geometry.mockReturnValue(geometry);
  mocks.draw.mockReturnValue(cube);
  mocks.effect.mockImplementation(
    (_gpu: unknown, shader: keyof typeof effects) => effects[shader]
  );
  mocks.frame.mockImplementation(
    (_gpu: unknown, encode: (currentFrame: unknown) => void) => {
      encode({
        pass: (
          options: { target: { name: string } },
          drawPass: (pass: unknown) => void
        ) => {
          events.push(`pass:${options.target.name}`);
          drawPass({
            draw: (value: { name: string }) =>
              events.push(`draw:${value.name}`),
          });
        },
      });
    }
  );
  const output = {
    format: "bgra8unorm" as GPUTextureFormat,
    size: [800, 450] as [number, number],
  };
  return {
    copies,
    cube,
    effects,
    encoder,
    env,
    events,
    geometry,
    gpu,
    output,
    targets,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
});

test("builds the HDR scene in the original environment, blur, metal, and present order", async () => {
  const state = setup();
  const scene = await createScene(state.gpu as never, state.output as never);

  expect(state.targets.map(({ size }) => size)).toEqual([
    [800, 450],
    [2048, 1024],
    [1024, 512],
    [1024, 512],
    [512, 256],
    [512, 256],
    [256, 128],
    [256, 128],
    [128, 64],
    [128, 64],
    [64, 32],
    [64, 32],
    [32, 16],
    [32, 16],
    [16, 8],
    [16, 8],
  ]);
  expect(state.gpu.device.createTexture).toHaveBeenCalledWith({
    kind: "2d",
    format: "rgba16float",
    mipLevelCount: 8,
    size: [2048, 1024],
    usage: ["texture_binding", "copy_dst"],
  });
  expect(state.copies.map(({ destination }) => destination)).toEqual(
    Array.from({ length: 8 }, (_, mipLevel) => ({
      mipLevel,
      texture: state.env.gpu,
    }))
  );
  expect(state.copies.map(({ size }) => size)).toEqual([
    [2048, 1024, 1],
    [1024, 512, 1],
    [512, 256, 1],
    [256, 128, 1],
    [128, 64, 1],
    [64, 32, 1],
    [32, 16, 1],
    [16, 8, 1],
  ]);
  expect(state.events.filter((event) => event === "draw:sky")).toHaveLength(1);
  expect(state.events.filter((event) => event === "draw:blur")).toHaveLength(
    14
  );
  expect(state.events.filter((event) => event === "submit")).toHaveLength(8);
  expect(
    state.targets
      .slice(1)
      .every((value) => value.destroy.mock.calls.length === 1)
  ).toBe(true);
  expect(scene).toEqual({
    cube: state.cube,
    env: state.env,
    geometry: state.geometry,
    hdr: state.targets[0],
    present: state.effects.present,
  });
  expect(state.env.destroy).not.toHaveBeenCalled();
  expect(state.geometry.destroy).not.toHaveBeenCalled();
  expect(state.targets[0].destroy).not.toHaveBeenCalled();
});

test("rolls back a partially allocated environment without masking the allocation failure", async () => {
  const state = setup();
  const primary = new Error("vertical target failed");
  const secondary = new Error("horizontal cleanup failed");
  const originalTarget = mocks.target.getMockImplementation()!;
  let targetCall = 0;
  mocks.target.mockImplementation((gpu: unknown, options: unknown) => {
    targetCall++;
    if (targetCall === 4) throw primary;
    const value = originalTarget(gpu, options);
    if (targetCall === 3) {
      value.destroy.mockImplementation(() => {
        state.events.push("destroy:target-2");
        throw secondary;
      });
    }
    return value;
  });

  await expect(
    createScene(state.gpu as never, state.output as never)
  ).rejects.toBe(primary);
  expect(state.targets[2].destroy).toHaveBeenCalledOnce();
  expect(state.targets[1].destroy).toHaveBeenCalledOnce();
  expect(state.env.destroy).toHaveBeenCalledOnce();
  expect(state.targets[0].destroy).toHaveBeenCalledOnce();
});

test("rolls back compiled scene children and preserves the primary compile failure", async () => {
  const state = setup();
  const primary = new Error("cube compile failed");
  state.cube.compile.mockRejectedValue(primary);
  state.env.destroy.mockImplementation(() => {
    state.events.push("destroy:env");
    throw new Error("environment cleanup failed");
  });

  await expect(
    createScene(state.gpu as never, state.output as never)
  ).rejects.toBe(primary);
  expect(state.geometry.destroy).toHaveBeenCalledOnce();
  expect(state.env.destroy).toHaveBeenCalledOnce();
  expect(state.targets[0].destroy).toHaveBeenCalledOnce();
});

test.each(["first", "second"] as const)(
  "waits for the peer when the %s scene compile rejects",
  async (failedAttempt) => {
    const state = setup();
    const primary = new Error(`${failedAttempt} scene compile failed`);
    const peer = deferred();
    const first = state.cube.compile;
    const second = state.effects.present.compile;
    (failedAttempt === "first" ? first : second).mockRejectedValue(primary);
    (failedAttempt === "first" ? second : first).mockReturnValue(peer.promise);

    const creating = createScene(state.gpu as never, state.output as never);
    await vi.waitFor(() => {
      expect(first).toHaveBeenCalledOnce();
      expect(second).toHaveBeenCalledOnce();
    });
    expect(state.targets[0].destroy).not.toHaveBeenCalled();
    expect(state.env.destroy).not.toHaveBeenCalled();
    expect(state.geometry.destroy).not.toHaveBeenCalled();

    peer.resolve();
    await expect(creating).rejects.toBe(primary);
    expect(state.targets[0].destroy).toHaveBeenCalledOnce();
    expect(state.env.destroy).toHaveBeenCalledOnce();
    expect(state.geometry.destroy).toHaveBeenCalledOnce();
  }
);

test("attempts both synchronous scene compiles and reports the first one", async () => {
  const state = setup();
  const first = new Error("cube compile failed synchronously");
  state.cube.compile.mockImplementation(() => {
    throw first;
  });
  state.effects.present.compile.mockImplementation(() => {
    throw new Error("present compile failed synchronously");
  });

  await expect(
    createScene(state.gpu as never, state.output as never)
  ).rejects.toBe(first);
  expect(state.cube.compile).toHaveBeenCalledOnce();
  expect(state.effects.present.compile).toHaveBeenCalledOnce();
});

test.each(["first", "second"] as const)(
  "waits for the peer when the %s environment compile rejects",
  async (failedAttempt) => {
    const state = setup();
    const primary = new Error(`${failedAttempt} environment compile failed`);
    const peer = deferred();
    const first = state.effects.sky.compile;
    const second = state.effects.blur.compile;
    (failedAttempt === "first" ? first : second).mockRejectedValue(primary);
    (failedAttempt === "first" ? second : first).mockReturnValue(peer.promise);

    const creating = createScene(state.gpu as never, state.output as never);
    await vi.waitFor(() => {
      expect(first).toHaveBeenCalledOnce();
      expect(second).toHaveBeenCalledOnce();
    });
    expect(state.targets[0].destroy).not.toHaveBeenCalled();
    expect(state.targets[1].destroy).not.toHaveBeenCalled();
    expect(state.env.destroy).not.toHaveBeenCalled();

    peer.resolve();
    await expect(creating).rejects.toBe(primary);
    expect(state.targets[0].destroy).toHaveBeenCalledOnce();
    expect(state.targets[1].destroy).toHaveBeenCalledOnce();
    expect(state.env.destroy).toHaveBeenCalledOnce();
  }
);

test("attempts both synchronous environment compiles and reports the first one", async () => {
  const state = setup();
  const first = new Error("sky compile failed synchronously");
  state.effects.sky.compile.mockImplementation(() => {
    throw first;
  });
  state.effects.blur.compile.mockImplementation(() => {
    throw new Error("blur compile failed synchronously");
  });

  await expect(
    createScene(state.gpu as never, state.output as never)
  ).rejects.toBe(first);
  expect(state.effects.sky.compile).toHaveBeenCalledOnce();
  expect(state.effects.blur.compile).toHaveBeenCalledOnce();
});

test("renders metal before the present composite with the current camera", () => {
  const state = setup();
  const passes: unknown[] = [];
  const draws: unknown[] = [];
  const currentFrame = {
    pass: (options: unknown, encode: (pass: unknown) => void) => {
      passes.push(options);
      encode({ draw: (value: unknown) => draws.push(value) });
    },
  };
  const scene = {
    cube: state.cube,
    env: state.env,
    geometry: state.geometry,
    hdr: targetResource("hdr", [800, 450], "rgba16float", state.events),
    present: state.effects.present,
  };
  const view = cameraView(0.6, 0.12, 16 / 9);

  render(
    currentFrame as never,
    scene as never,
    state.output as never,
    view,
    2.1
  );

  expect(passes).toEqual([
    { clear: [0, 0, 0, 0], target: scene.hdr },
    { target: state.output },
  ]);
  expect(draws).toEqual([state.cube, state.effects.present]);
  expect(state.cube.set).toHaveBeenCalledWith({
    camera_position: view.position,
    model: expect.any(Float32Array),
    view_projection: view.camera.viewProjection,
  });
  expect(state.effects.present.set).toHaveBeenCalledWith({
    camera: expect.objectContaining({
      aspect: 16 / 9,
      position: view.position,
    }),
  });
});

test("commits HDR replacements only after rebinding the present pass", () => {
  const state = setup();
  const previous = targetResource(
    "previous",
    [1, 1],
    "rgba16float",
    state.events
  );
  const next = targetResource("next", [2, 3], "rgba16float", state.events);
  mocks.target.mockReturnValue(next);
  const present = { set: vi.fn() };
  const scene = { hdr: previous, present };

  replaceHdr(state.gpu as never, scene as never, [2, 3]);

  expect(present.set).toHaveBeenCalledWith({ scene_tex: next });
  expect(scene.hdr).toBe(next);
  expect(previous.destroy).toHaveBeenCalledOnce();
  expect(next.destroy).not.toHaveBeenCalled();
});

test("restores the previous HDR binding and destroys a rejected replacement", () => {
  const state = setup();
  const previous = targetResource(
    "previous",
    [1, 1],
    "rgba16float",
    state.events
  );
  const next = targetResource("next", [2, 3], "rgba16float", state.events);
  const primary = new Error("bind failed");
  mocks.target.mockReturnValue(next);
  const present = {
    set: vi
      .fn()
      .mockImplementationOnce(() => {
        throw primary;
      })
      .mockImplementationOnce(() => {
        throw new Error("rollback bind failed");
      }),
  };
  const scene = { hdr: previous, present };

  expect(() => replaceHdr(state.gpu as never, scene as never, [2, 3])).toThrow(
    primary
  );
  expect(present.set).toHaveBeenNthCalledWith(2, { scene_tex: previous });
  expect(scene.hdr).toBe(previous);
  expect(next.destroy).toHaveBeenCalledOnce();
  expect(previous.destroy).not.toHaveBeenCalled();
});

test("scene cleanup attempts every owned child and reports the first failure", () => {
  const events: string[] = [];
  const primary = new Error("geometry cleanup failed");
  const geometry = tracked("geometry", events);
  const hdr = targetResource("hdr", [1, 1], "rgba16float", events);
  const env = tracked("env", events);
  geometry.destroy.mockImplementation(() => {
    events.push("destroy:geometry");
    throw primary;
  });
  hdr.destroy.mockImplementation(() => {
    events.push("destroy:hdr");
    throw new Error("hdr cleanup failed");
  });

  expect(() => destroyScene({ env, geometry, hdr } as never)).toThrow(primary);
  expect(events).toEqual(["destroy:geometry", "destroy:hdr", "destroy:env"]);
});
