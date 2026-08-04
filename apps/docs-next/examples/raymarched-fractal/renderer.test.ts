import { afterEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ init: vi.fn() }));
const vgpuFns = vi.hoisted(() => Object.fromEntries(
  ['surface', 'target', 'effect', 'draw', 'geometry', 'sampler', 'bundle', 'compute', 'storage', 'uniforms', 'timer', 'visibility', 'pingPong', 'pingPongStorage', 'frame', 'frameLoop']
    // Each test's gpu double carries its factory fakes in `fns`; these route the free functions to them.
    .map((name) => [name, (gpu: any, ...args: any[]) => gpu.fns[name](...args)]),
)) as Record<string, unknown>;
vi.mock('vgpu', () => ({ init: mocks.init, ...vgpuFns, clock: (gpu: any) => gpu.clock ?? { time: 0, deltaTime: 0, frameCount: 0, advance() {} } }));

import { createRenderer, renderThumbnail } from './renderer';

const canvas = {
  style: { touchAction: '' },
  getBoundingClientRect: () => ({ width: 100, height: 50 }),
  addEventListener: vi.fn(), removeEventListener: vi.fn(),
} as unknown as HTMLCanvasElement;

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

test('thumbnail prewarm failure waits for submitted work and destroys all targets', async () => {
  const failure = new Error('prewarm failed');
  let effectIndex = 0;
  const effect = vi.fn(() => ({
    set: vi.fn(),
    compile: effectIndex++ === 0 ? vi.fn(async () => { throw failure; }) : vi.fn(async () => {}),
  }));
  const destroyed = [vi.fn(), vi.fn(), vi.fn()];
  let targetIndex = 0;
  const target = vi.fn(() => ({
    size: [100, 50] as const, format: 'rgba16float', texelSize: [0.01, 0.02],
    color: { destroy: destroyed[targetIndex++]! }, resize: vi.fn(),
  }));
  const onSubmittedWorkDone = vi.fn(async () => {});
  const gpu = { gpu: { queue: { onSubmittedWorkDone } } , fns: { effect, sampler: vi.fn(() => ({})), target }};
  await expect(renderThumbnail(gpu as never, { size: [100, 50], format: 'rgba8unorm' } as never)).rejects.toBe(failure);
  expect(onSubmittedWorkDone).toHaveBeenCalledOnce();
  for (const destroy of destroyed) expect(destroy).toHaveBeenCalledOnce();
});

test('dispose before readiness is idempotent and destroys a GPU that resolves late', async () => {
  vi.stubGlobal('window', { devicePixelRatio: 1, addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  const gpu = { dispose: vi.fn() };
  let resolve!: (value: typeof gpu) => void;
  mocks.init.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
  const renderer = createRenderer({ canvas });
  await vi.waitFor(() => expect(mocks.init).toHaveBeenCalledOnce());
  renderer.dispose();
  renderer.dispose();
  resolve(gpu);
  await renderer.ready;
  expect(gpu.dispose).toHaveBeenCalledOnce();
  expect(requestAnimationFrame).not.toHaveBeenCalled();
});
