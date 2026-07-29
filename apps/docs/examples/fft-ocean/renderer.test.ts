import { afterEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ init: vi.fn() }));
const vgpuFns = vi.hoisted(() => Object.fromEntries(
  ['surface', 'target', 'effect', 'draw', 'geometry', 'sampler', 'bundle', 'compute', 'storage', 'uniforms', 'timer', 'visibility', 'pingPong', 'pingPongStorage', 'frame', 'frameLoop']
    // Each test's gpu double carries its factory fakes in `fns`; these route the free functions to them.
    .map((name) => [name, (gpu: any, ...args: any[]) => gpu.fns[name](...args)]),
)) as Record<string, unknown>;
vi.mock('vgpu', () => ({ init: mocks.init, ...vgpuFns, clock: (gpu: any) => gpu.clock ?? { time: 0, deltaTime: 0, frameCount: 0, advance() {} } }));

import { createRenderer, renderThumbnail } from './renderer';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

test('dispose-before-ready destroys a late GPU and never starts the ocean graph', async () => {
  vi.stubGlobal('window', { devicePixelRatio: 1, addEventListener: vi.fn(), removeEventListener: vi.fn() });
  const pending = deferred<{ dispose(): void; surface: ReturnType<typeof vi.fn>; frame: { loop: ReturnType<typeof vi.fn> } }>();
  mocks.init.mockReturnValueOnce(pending.promise);
  const canvas = { getBoundingClientRect: () => ({ width: 100, height: 50 }) } as HTMLCanvasElement;
  const renderer = createRenderer({ canvas });
  await vi.waitFor(() => expect(mocks.init).toHaveBeenCalledOnce());
  renderer.dispose();
  renderer.dispose();
  const gpu = { dispose: vi.fn(), fns: { surface: vi.fn(), frameLoop: vi.fn() }};
  pending.resolve(gpu);
  await renderer.ready;
  expect(gpu.dispose).toHaveBeenCalledOnce();
  expect(gpu.fns.surface).not.toHaveBeenCalled();
  expect(gpu.fns.frameLoop).not.toHaveBeenCalled();
});

test('thumbnail graph construction destroys targets acquired before an allocation failure', async () => {
  const destroyFirst = vi.fn();
  const destroySecond = vi.fn();
  const targets = [
    { color: { destroy: destroyFirst } },
    { color: { destroy: destroySecond } },
  ];
  const gpu = { fns: {
    target: vi.fn(() => {
      const target = targets.shift();
      if (!target) throw new Error('target allocation failed');
      return target;
    }) }} as unknown as Parameters<typeof renderThumbnail>[0];
  const output = { size: [100, 50], format: 'rgba8unorm' } as unknown as Parameters<typeof renderThumbnail>[1];

  await expect(renderThumbnail(gpu, output)).rejects.toThrow('target allocation failed');
  expect(destroySecond).toHaveBeenCalledOnce();
  expect(destroyFirst).toHaveBeenCalledOnce();
});
