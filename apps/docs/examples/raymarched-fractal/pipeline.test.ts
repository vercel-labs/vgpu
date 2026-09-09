import { expect, test, vi } from "vitest";

const routed = vi.hoisted(() => ({
  effect: (gpu: FakeGpu, ...args: Parameters<FakeGpu["fns"]["effect"]>) =>
    gpu.fns.effect(...args),
  sampler: (gpu: FakeGpu, ...args: Parameters<FakeGpu["fns"]["sampler"]>) =>
    gpu.fns.sampler(...args),
  target: (gpu: FakeGpu, ...args: Parameters<FakeGpu["fns"]["target"]>) =>
    gpu.fns.target(...args),
}));

vi.mock("vgpu", () => routed);

import {
  compileScene,
  createScene,
  destroyScene,
  renderScene,
  replaceTargets,
} from "./pipeline";

interface FakeEffect {
  compile: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  setError?: unknown;
  sets: unknown[];
}

interface FakeTarget {
  color: { destroy: ReturnType<typeof vi.fn> };
  destroyError?: unknown;
  format: GPUTextureFormat;
  size: [number, number];
  texelSize: [number, number];
}

interface FakeGpu {
  fns: {
    effect: ReturnType<typeof vi.fn<() => FakeEffect>>;
    sampler: ReturnType<typeof vi.fn<() => object>>;
    target: ReturnType<
      typeof vi.fn<
        (options: {
          format: GPUTextureFormat;
          size: [number, number];
        }) => FakeTarget
      >
    >;
  };
}

function deferred() {
  let resolve!: () => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, reject, resolve };
}

function setup() {
  const effects: FakeEffect[] = [];
  const targets: FakeTarget[] = [];
  const fail = {
    effectAt: 0,
    effectError: undefined as unknown,
    targetAt: 0,
    targetError: undefined as unknown,
  };
  let effectCalls = 0;
  let targetCalls = 0;
  const gpu: FakeGpu = {
    fns: {
      effect: vi.fn(() => {
        effectCalls++;
        if (effectCalls === fail.effectAt) throw fail.effectError;
        const value: FakeEffect = {
          compile: vi.fn(async () => {}),
          sets: [],
          set: vi.fn((values: unknown) => {
            if (value.setError !== undefined) throw value.setError;
            value.sets.push(values);
            return value;
          }),
        };
        effects.push(value);
        return value;
      }),
      sampler: vi.fn(() => ({})),
      target: vi.fn(
        (options: { format: GPUTextureFormat; size: [number, number] }) => {
          targetCalls++;
          if (targetCalls === fail.targetAt) throw fail.targetError;
          const value: FakeTarget = {
            color: {
              destroy: vi.fn(() => {
                if (value.destroyError !== undefined) throw value.destroyError;
              }),
            },
            format: options.format,
            size: [...options.size],
            texelSize: [1 / options.size[0], 1 / options.size[1]],
          };
          targets.push(value);
          return value;
        }
      ),
    },
  };
  return { effects, fail, gpu, targets };
}

test("partial effect or target construction never allocates later targets and preserves identity", () => {
  const effectEnv = setup();
  const effectFailure = new Error("effect failed");
  effectEnv.fail.effectAt = 3;
  effectEnv.fail.effectError = effectFailure;
  expect(() => createScene(effectEnv.gpu as never, [100, 50])).toThrow(
    effectFailure
  );
  expect(effectEnv.effects).toHaveLength(2);
  expect(effectEnv.targets).toHaveLength(0);

  const targetEnv = setup();
  const allocationFailure = new Error("target failed");
  targetEnv.fail.targetAt = 3;
  targetEnv.fail.targetError = allocationFailure;
  expect(() => createScene(targetEnv.gpu as never, [100, 50])).toThrow(
    allocationFailure
  );
  expect(targetEnv.targets).toHaveLength(2);
  expect(targetEnv.targets[0]!.color.destroy).toHaveBeenCalledOnce();
  expect(targetEnv.targets[1]!.color.destroy).toHaveBeenCalledOnce();
});

test("initial binding failure destroys every target without masking the binding error", () => {
  const env = setup();
  const primary = new Error("bind failed");
  const cleanup = new Error("cleanup failed");
  env.gpu.fns.target.mockImplementationOnce((options) => {
    const value = makeTarget(options, cleanup);
    env.targets.push(value);
    return value;
  });
  env.gpu.fns.effect.mockImplementationOnce(() => {
    const value = makeEffect();
    value.set.mockImplementation((values: unknown) => {
      if (value.set.mock.calls.length === 2) throw primary;
      value.sets.push(values);
      return value;
    });
    env.effects.push(value);
    return value;
  });

  expect(() => createScene(env.gpu as never, [100, 50])).toThrow(primary);
  expect(env.targets).toHaveLength(3);
  for (const target of env.targets)
    expect(target.color.destroy).toHaveBeenCalledOnce();
});

test("compilation starts every operation, drains pending work, and reports the first error", async () => {
  const env = setup();
  const scene = createScene(env.gpu as never, [100, 50]);
  const pending = deferred();
  const primary = new Error("scene compile failed");
  env.effects[0]!.compile.mockRejectedValue(primary);
  env.effects[1]!.compile.mockReturnValue(pending.promise);
  env.effects[2]!.compile.mockImplementation(() => {
    throw new Error("sync compile failed");
  });

  let settled = false;
  const compiling = compileScene(scene, {
    format: "rgba8unorm",
  } as never).finally(() => {
    settled = true;
  });
  await vi.waitFor(() =>
    expect(
      env.effects.every(({ compile }) => compile.mock.calls.length === 1)
    ).toBe(true)
  );
  expect(settled).toBe(false);
  pending.resolve();
  await expect(compiling).rejects.toBe(primary);
});

test("target replacement commits only after every binding succeeds", () => {
  const env = setup();
  const scene = createScene(env.gpu as never, [100, 50]);
  const previous = scene.targets;
  const oldTargets = env.targets.slice();
  replaceTargets(env.gpu as never, scene, [800, 450]);

  expect(scene.targets).not.toBe(previous);
  expect(scene.targets.scene.size).toEqual([800, 450]);
  expect(scene.targets.bloomA.size).toEqual([640, 360]);
  for (const target of oldTargets)
    expect(target.color.destroy).toHaveBeenCalledOnce();
});

test("failed replacement restores all old bindings and releases all new targets", () => {
  const env = setup();
  const scene = createScene(env.gpu as never, [100, 50]);
  const previous = scene.targets;
  const callsBefore = env.effects.map(({ set }) => set.mock.calls.length);
  const primary = new Error("replacement bind failed");
  env.effects[2]!.setError = primary;

  expect(() => replaceTargets(env.gpu as never, scene, [800, 450])).toThrow(
    primary
  );
  expect(scene.targets).toBe(previous);
  const replacements = env.targets.slice(3);
  expect(replacements).toHaveLength(3);
  for (const target of replacements)
    expect(target.color.destroy).toHaveBeenCalledOnce();
  for (let index = 0; index < env.effects.length; index++) {
    expect(env.effects[index]!.set.mock.calls.length).toBe(
      callsBefore[index]! + 2
    );
  }
});

test("a cleanup failure after replacement leaves the new targets committed", () => {
  const env = setup();
  const scene = createScene(env.gpu as never, [100, 50]);
  const previous = scene.targets;
  const cleanupFailure = new Error("old target cleanup failed");
  env.targets[0]!.destroyError = cleanupFailure;

  expect(() => replaceTargets(env.gpu as never, scene, [200, 100])).toThrow(
    cleanupFailure
  );
  expect(scene.targets).not.toBe(previous);
  for (const target of env.targets.slice(0, 3)) {
    expect(target.color.destroy).toHaveBeenCalledOnce();
  }
});

test("destroy and render traverse the complete graph in deterministic order", () => {
  const env = setup();
  const scene = createScene(env.gpu as never, [100, 50]);
  const passes: Array<{ drawable: FakeEffect; target: unknown }> = [];
  const currentFrame = {
    pass: (
      options: { target: unknown },
      draw: (pass: { draw(value: FakeEffect): void }) => void
    ) =>
      draw({
        draw: (drawable) => passes.push({ drawable, target: options.target }),
      }),
  };
  renderScene(currentFrame as never, scene, { output: true } as never, {
    yaw: 1.2,
    pitch: -0.4,
  });
  expect(passes.map(({ drawable }) => env.effects.indexOf(drawable))).toEqual([
    0, 1, 2, 3, 4,
  ]);
  expect(env.effects[0]!.sets.at(-1)).toEqual({
    params: { yaw: 1.2, pitch: -0.4 },
  });

  const first = new Error("first cleanup failed");
  env.targets[0]!.destroyError = first;
  env.targets[1]!.destroyError = new Error("later cleanup failed");
  expect(() => destroyScene(scene)).toThrow(first);
  for (const target of env.targets)
    expect(target.color.destroy).toHaveBeenCalledOnce();
});

function makeEffect(setError?: unknown): FakeEffect {
  const value: FakeEffect = {
    compile: vi.fn(async () => {}),
    setError,
    sets: [],
    set: vi.fn((values: unknown) => {
      if (value.setError !== undefined) throw value.setError;
      value.sets.push(values);
      return value;
    }),
  };
  return value;
}

function makeTarget(
  options: { format: GPUTextureFormat; size: [number, number] },
  destroyError?: unknown
): FakeTarget {
  const value: FakeTarget = {
    color: {
      destroy: vi.fn(() => {
        if (value.destroyError !== undefined) throw value.destroyError;
      }),
    },
    destroyError,
    format: options.format,
    size: [...options.size],
    texelSize: [1 / options.size[0], 1 / options.size[1]],
  };
  return value;
}
