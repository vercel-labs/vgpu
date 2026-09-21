import { afterEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  effect: vi.fn(),
  sampler: vi.fn(() => ({ sampler: true })),
  target: vi.fn(),
}));

vi.mock('vgpu', () => mocks);

import { createScene, DEFAULT_CONTROLS } from './scene';

function fakeTarget(size: readonly [number, number], label: string) {
  let currentSize = [...size] as [number, number];
  return {
    destroy: vi.fn(),
    format: 'rgba16float',
    get size() {
      return currentSize;
    },
    get texelSize() {
      return [1 / currentSize[0], 1 / currentSize[1]];
    },
    label,
    resize: vi.fn((next: readonly [number, number]) => {
      currentSize = [...next] as [number, number];
    }),
  };
}

function fakeEffect(label: string) {
  return {
    compile: vi.fn(async () => undefined),
    label,
    set: vi.fn(),
  };
}

afterEach(() => vi.resetAllMocks());

test('resizes the live target graph before rendering the next frame', async () => {
  const effects = new Map<string, ReturnType<typeof fakeEffect>>();
  mocks.effect.mockImplementation((_gpu, _shader, options) => {
    const created = fakeEffect(options.label);
    effects.set(options.label, created);
    return created;
  });
  mocks.target.mockImplementation((_gpu, options) => fakeTarget(options.size, options.label));
  const output = { format: 'bgra8unorm', size: [800, 400] as const };
  const scene = createScene({} as never, output as never, DEFAULT_CONTROLS);
  await scene.prepare(output as never);
  scene.resize([600, 300], 0.5);

  const passes: unknown[] = [];
  scene.render(
    { pass: (target: unknown) => passes.push(target) } as never,
    output as never,
    { yaw: 0.9, pitch: 0.28, radius: 3.6 },
    DEFAULT_CONTROLS,
    {
      sculptureTime: 1,
      clockTime: 2,
      deltaTime: 1 / 60,
      light: { azimuth: 0.9, elevation: 0.55 },
    },
  );

  expect((passes[0] as { size: readonly number[] }).size).toEqual([300, 150]);
  expect((passes[1] as { size: readonly number[] }).size).toEqual([75, 37]);
  expect(effects.get('glass-sculpture')?.set).toHaveBeenLastCalledWith(
    expect.objectContaining({ params: expect.objectContaining({ resolution: [300, 150] }) }),
  );
  expect(passes.at(-1)).toBe(output);
});

test('destroys only scene-owned targets when used with a shared gpu', () => {
  const targets: Array<ReturnType<typeof fakeTarget>> = [];
  mocks.effect.mockImplementation((_gpu, _shader, options) => fakeEffect(options.label));
  mocks.target.mockImplementation((_gpu, options) => {
    const created = fakeTarget(options.size, options.label);
    targets.push(created);
    return created;
  });
  const output = { format: 'rgba8unorm', size: [160, 90] as const };
  const scene = createScene({} as never, output as never, DEFAULT_CONTROLS);
  scene.destroy();

  expect(targets).toHaveLength(3);
  expect(targets.every((created) => created.destroy.mock.calls.length === 1)).toBe(true);
});
