import { expect, test, vi } from 'vitest';

const vgpuFns = vi.hoisted(
  () =>
    Object.fromEntries(
      ['target', 'effect', 'sampler', 'frame'].map((name) => [
        name,
        // Each test's GPU double carries its factory fakes in `fns`.
        (gpu: any, ...args: any[]) => gpu.fns[name](...args),
      ]),
    ) as Record<string, unknown>,
);
vi.mock('vgpu', () => vgpuFns);

import { createFluid, fluidSize, PRESSURE_ITERATIONS, QUALITY_CELLS, type StepInput } from './fluid';
import { paletteColor, PALETTES } from './pipeline';

interface FakeTarget {
  label: string;
  size: readonly [number, number];
  texelSize: readonly [number, number];
  resize: ReturnType<typeof vi.fn>;
}

function gpu() {
  const targets: FakeTarget[] = [];
  const effects: Array<{ label: string; set: ReturnType<typeof vi.fn>; compile: ReturnType<typeof vi.fn> }> = [];
  const passes: string[] = [];
  const currentFrame = { pass: vi.fn((output: FakeTarget) => passes.push(output.label)) };
  const instance = {
    fns: {
      target: vi.fn((options: { size: readonly [number, number]; label: string }) => {
        const created: FakeTarget = {
          label: options.label.replace('throwable-fluid-', ''),
          size: options.size,
          texelSize: [1 / options.size[0], 1 / options.size[1]],
          resize: vi.fn(),
        };
        targets.push(created);
        return created;
      }),
      effect: vi.fn((_shader: unknown, options: { label: string }) => {
        const created = { label: options.label, set: vi.fn(), compile: vi.fn(async () => {}) };
        effects.push(created);
        return created;
      }),
      sampler: vi.fn(() => ({})),
      frame: vi.fn((callback: (frame: typeof currentFrame) => void) => callback(currentFrame)),
    },
  };
  return { instance, targets, effects, passes, currentFrame };
}

const INPUT: StepInput = {
  dt: 1 / 60,
  aspect: 16 / 9,
  params: { viscosity: 0.03, vorticity: 22, dissipation: 0.3, damping: 0.35 },
  stroke: { from: [0.2, 0.5], to: [0.25, 0.5], velocity: [300, 0], radius: 0.08, drag: 0.3, amount: 0.5, color: [0, 1, 1] },
  splash: null,
};

test('the grid keeps square cells on the canvas aspect and the dye runs 2–4× finer', () => {
  const wide = fluidSize(2560, 1440, 'medium');
  expect(wide.grid).toEqual([256, QUALITY_CELLS.medium]);
  expect(wide.dye).toEqual([1024, 576]);

  const tall = fluidSize(780, 1688, 'low');
  expect(tall.grid[0]).toBe(QUALITY_CELLS.low);
  expect(tall.grid[1]).toBe(Math.round(QUALITY_CELLS.low * (1688 / 780)));
  // Never much finer than the pixels the dye lands on, never coarser than 2×.
  const small = fluidSize(320, 180, 'high');
  expect(small.dye[1] / small.grid[1]).toBe(2);
  // Very long strips stop at 3:1 so the cells stay affordable.
  expect(fluidSize(4000, 400, 'medium').grid).toEqual([QUALITY_CELLS.medium * 3, QUALITY_CELLS.medium]);
});

test('a step runs curl, forces, projection and dye advection in a fixed order', () => {
  const { instance, passes, currentFrame } = gpu();
  const fluid = createFluid(instance as never, fluidSize(1280, 720, 'medium'));
  fluid.step(currentFrame as never, INPUT);
  expect(passes).toEqual([
    'curl',
    'velocity-b',
    'divergence',
    ...Array.from({ length: PRESSURE_ITERATIONS }, (_, i) => (i % 2 === 0 ? 'pressure-b' : 'pressure-a')),
    'velocity-a',
    'dye-b',
  ]);
  // Velocity and pressure end each step in their first targets; only the dye alternates.
  expect(passes.at(-3)).toBe('pressure-a');
  expect(fluid.current).toBe(1);
  fluid.step(currentFrame as never, INPUT);
  expect(passes.at(-1)).toBe('dye-a');
  expect(fluid.current).toBe(0);
});

test('the step hands the stroke and a splash to the shaders', () => {
  const { instance, effects, currentFrame } = gpu();
  const fluid = createFluid(instance as never, fluidSize(1280, 720, 'medium'));
  const splash = { center: [0.9, 0.5] as const, radius: 0.1, jet: [-200, 0] as const, swirl: 0, amount: 0.5, color: [1, 0, 1] as const, arms: 0, turn: 0 };
  fluid.step(currentFrame as never, { ...INPUT, splash });
  const stir = effects.find((effect) => effect.label.endsWith('advect-velocity'))!.set.mock.calls[0]![0].stir;
  expect(stir).toMatchObject({ segmentStart: [0.2, 0.5], segmentEnd: [0.25, 0.5], orbVelocity: [300, 0], splashJet: [-200, 0], dissipation: 0.35 });
  const ink = effects.find((effect) => effect.label.endsWith('advect-dye-a'))!.set.mock.calls[0]![0].ink;
  expect(ink).toMatchObject({ amount: 0.5, splashAmount: 0.5, splashCenter: [0.9, 0.5], dissipation: 0.3 });
});

test('resizing stretches velocity and dye in two frames and rescales velocity to the grid', () => {
  const { instance, targets, effects, passes } = gpu();
  const before = fluidSize(1280, 720, 'medium');
  const fluid = createFluid(instance as never, before);
  const after = fluidSize(640, 720, 'medium');
  fluid.resize(after);
  expect(instance.fns.frame).toHaveBeenCalledTimes(2);
  expect(passes).toEqual(['velocity-b', 'dye-b', 'velocity-a', 'dye-a']);
  for (const target of targets) {
    const expected = target.label.startsWith('dye') ? after.dye : after.grid;
    expect(target.resize).toHaveBeenCalledWith(expected);
  }
  const carry = effects.find((effect) => effect.label.endsWith('carry-velocity-a'))!;
  expect(carry.set).toHaveBeenCalledWith({
    carry: { scale: [after.grid[0] / before.grid[0], after.grid[1] / before.grid[1], 1, 1] },
  });
  expect(fluid.size).toBe(after);

  // The same size again changes nothing.
  fluid.resize(fluidSize(640, 720, 'medium'));
  expect(instance.fns.frame).toHaveBeenCalledTimes(2);
});

test('the palette blends smoothly round a closed loop', () => {
  expect(paletteColor('Aurora', 0)).toEqual([...PALETTES.Aurora[0]]);
  expect(paletteColor('Aurora', 1)).toEqual(paletteColor('Aurora', 0));
  expect(paletteColor('Aurora', -0.25)).toEqual(paletteColor('Aurora', 0.75));
  const [r, g, b] = paletteColor('Ember', 0.125);
  expect(r).toBeCloseTo(1, 6);
  expect(g).toBeCloseTo((0.35 + 0.7) / 2, 6);
  expect(b).toBeCloseTo((0.05 + 0.1) / 2, 6);
});
