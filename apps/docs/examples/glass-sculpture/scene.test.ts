import { afterEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  effect: vi.fn(),
  frame: vi.fn(),
  sampler: vi.fn(),
  target: vi.fn(),
}));

vi.mock("vgpu", () => mocks);

import {
  DEFAULT_CONTROLS,
  RIGS,
  createScene,
  createTargets,
  destroyScene,
  lightDirection,
  normalizeControls,
  renderScene,
  replaceTargets,
} from "./scene";

function colorTarget(
  name: string,
  size: readonly [number, number],
  events: string[] = []
) {
  return {
    color: { gpu: { name } },
    destroy: vi.fn(() => events.push(name)),
    size,
  };
}

function fakeEffect(name: string) {
  return {
    compile: vi.fn(async () => undefined),
    name,
    set: vi.fn(),
  };
}

afterEach(() => {
  vi.resetAllMocks();
});

test("normalizes every public control back into the allowed vocabulary", () => {
  expect(
    normalizeControls({
      dispersion: 1 as never,
      glass: "amber" as never,
      light: "disco" as never,
      renderScale: 0.3 as never,
      shape: "cube" as never,
      spin: undefined as never,
    })
  ).toEqual({ ...DEFAULT_CONTROLS, dispersion: false, spin: true });
  expect(
    normalizeControls({
      dispersion: true,
      glass: "rose",
      light: "gel",
      renderScale: 1,
      shape: "droplets",
      spin: false,
    })
  ).toEqual({
    dispersion: true,
    glass: "rose",
    light: "gel",
    renderScale: 1,
    shape: "droplets",
    spin: false,
  });
});

test("light directions are unit vectors around +y", () => {
  const straightUp = lightDirection(0.3, Math.PI / 2);
  expect(straightUp[1]).toBeCloseTo(1);
  const forward = lightDirection(0, 0);
  expect(forward).toEqual([0, 0, 1]);
  const [x, y, z] = lightDirection(2.1, 0.6);
  expect(Math.hypot(x, y, z)).toBeCloseTo(1);
});

test("targets scale the HDR scene and keep the bloom chain at a quarter of it", () => {
  const created: Array<{ size: [number, number]; label: string }> = [];
  mocks.target.mockImplementation((_gpu, opts) => {
    created.push({ size: opts.size, label: opts.label });
    return colorTarget(opts.label, opts.size);
  });
  const targets = createTargets({} as never, [1000, 500], 0.5);
  expect(created).toEqual([
    { label: "glass-scene", size: [500, 250] },
    { label: "glass-bloom-a", size: [125, 62] },
    { label: "glass-bloom-b", size: [125, 62] },
  ]);
  expect(targets.scene.size).toEqual([500, 250]);

  // Nonsense scales fall back to something sane and never produce a 0-sized target.
  created.length = 0;
  createTargets({} as never, [3, 2], Number.NaN);
  expect(created[0]?.size).toEqual([2, 1]);
  expect(created[1]?.size).toEqual([1, 1]);
});

test("createScene binds every pass, compiles it, and cleans up when compilation fails", async () => {
  const events: string[] = [];
  mocks.target.mockImplementation((_gpu, opts) =>
    colorTarget(opts.label, opts.size, events)
  );
  mocks.sampler.mockReturnValue({ sampler: true });
  const effects: ReturnType<typeof fakeEffect>[] = [];
  mocks.effect.mockImplementation((_gpu, _source, opts) => {
    const created = fakeEffect(opts.label);
    effects.push(created);
    return created;
  });

  const output = { format: "bgra8unorm", size: [800, 400] as [number, number] };
  const scene = await createScene({} as never, output as never);
  expect(effects.map(({ name }) => name)).toEqual([
    "glass-sculpture",
    "glass-bloom-extract",
    "glass-bloom-blur-h",
    "glass-bloom-blur-v",
    "glass-present",
  ]);
  for (const created of effects) {
    expect(created.compile).toHaveBeenCalledTimes(1);
  }
  expect(scene.present.set).toHaveBeenCalledWith(
    expect.objectContaining({
      scene: scene.targets.scene,
      bloom: scene.targets.bloomA,
    })
  );
  expect(scene.rig.keyPower).toBe(RIGS.studio.keyPower);

  destroyScene(scene);
  expect(events).toEqual(["glass-bloom-b", "glass-bloom-a", "glass-scene"]);

  events.length = 0;
  effects.length = 0;
  const failure = new Error("compile failed");
  mocks.effect.mockImplementation((_gpu, _source, opts) => {
    const created = fakeEffect(opts.label);
    if (opts.label === "glass-present") {
      created.compile.mockRejectedValue(failure);
    }
    return created;
  });
  await expect(createScene({} as never, output as never)).rejects.toBe(failure);
  expect(events).toEqual(["glass-bloom-b", "glass-bloom-a", "glass-scene"]);
});

test("replaceTargets swaps in the new size and destroys the old targets last", async () => {
  const events: string[] = [];
  mocks.target.mockImplementation((_gpu, opts) =>
    colorTarget(`${opts.label}:${opts.size.join("x")}`, opts.size, events)
  );
  mocks.sampler.mockReturnValue({ sampler: true });
  mocks.effect.mockImplementation((_gpu, _source, opts) => fakeEffect(opts.label));
  const output = { format: "bgra8unorm", size: [800, 400] as [number, number] };
  const scene = await createScene({} as never, output as never);
  const previous = scene.targets;

  replaceTargets({} as never, scene, [400, 200], 1);
  expect(scene.targets).not.toBe(previous);
  expect(scene.targets.scene.size).toEqual([400, 200]);
  expect(events).toEqual([
    "glass-bloom-b:150x75",
    "glass-bloom-a:150x75",
    "glass-scene:600x300",
  ]);
  expect(scene.extract.set).toHaveBeenLastCalledWith(
    expect.objectContaining({ source: scene.targets.scene })
  );
});

test("renderScene eases the light rig toward the selected preset and records five passes", async () => {
  mocks.target.mockImplementation((_gpu, opts) => colorTarget(opts.label, opts.size));
  mocks.sampler.mockReturnValue({ sampler: true });
  mocks.effect.mockImplementation((_gpu, _source, opts) => fakeEffect(opts.label));
  const passes: Array<[unknown, unknown]> = [];
  mocks.frame.mockImplementation((_gpu, body) => {
    body({ pass: (target: unknown, drawable: unknown) => passes.push([target, drawable]) });
  });
  const output = { format: "bgra8unorm", size: [800, 400] as [number, number] };
  const scene = await createScene({} as never, output as never);
  const controls = { ...DEFAULT_CONTROLS, light: "noir" as const, glass: "cobalt" as const };
  const view = { yaw: 0.5, pitch: 0.3, radius: 3 };
  const state = { time: 2, clock: 4, light: { azimuth: 0.25, elevation: 0.5 } };

  renderScene({} as never, scene, output as never, () => view, controls, state);
  expect(passes.map(([target]) => target)).toEqual([
    scene.targets.scene,
    scene.targets.bloomA,
    scene.targets.bloomB,
    scene.targets.bloomA,
    output,
  ]);
  const params = (scene.sculpture.set as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]
    .params as Record<string, unknown>;
  expect(params).toMatchObject({
    resolution: scene.targets.scene.size,
    time: 2,
    tint: 2,
    shape: 1,
    yaw: 0.5,
    pitch: 0.3,
    radius: 3,
    dispersion: 1,
  });
  // One frame in, the rig is 4% of the way from studio toward noir.
  const expectedKeyPower =
    RIGS.studio.keyPower + (RIGS.noir.keyPower - RIGS.studio.keyPower) * 0.04;
  expect((params.key as number[])[3]).toBeCloseTo(expectedKeyPower);
  const key = params.key as number[];
  expect(Math.hypot(key[0]!, key[1]!, key[2]!)).toBeCloseTo(1);
  expect(key[1]).toBeCloseTo(Math.sin(0.5));

  for (let i = 0; i < 400; i++) {
    renderScene({} as never, scene, output as never, view, controls, state);
  }
  expect(scene.rig.keyPower).toBeCloseTo(RIGS.noir.keyPower, 3);
  expect(scene.rig.backgroundTop[0]).toBeCloseTo(RIGS.noir.backgroundTop[0], 3);
});
