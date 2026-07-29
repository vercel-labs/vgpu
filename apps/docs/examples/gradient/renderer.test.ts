import { afterEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  init: vi.fn(),
}));
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

function browser() {
  const listeners = new Map<string, EventListener>();
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  vi.stubGlobal('window', {
    devicePixelRatio: 1,
    addEventListener: vi.fn((name: string, listener: EventListener) => listeners.set(name, listener)),
    removeEventListener: vi.fn((name: string) => listeners.delete(name)),
  });
  vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  }));
  vi.stubGlobal('cancelAnimationFrame', vi.fn((id: number) => frames.delete(id)));
  const disconnect = vi.fn();
  vi.stubGlobal('ResizeObserver', class {
    observe = vi.fn();
    disconnect = disconnect;
  });
  const canvas = { getBoundingClientRect: () => ({ width: 100, height: 50 }) } as HTMLCanvasElement;
  return { canvas, listeners, frames, disconnect };
}

function gpu() {
  const stop = vi.fn();
  const surface = { size: [100, 50], resize: vi.fn(), dispose: vi.fn() };
  const instance = {
    clock: { time: 0, deltaTime: 1 / 60, frameCount: 0 },
    fns: {
      surface: vi.fn(() => surface),
      effect: vi.fn(() => ({ set: vi.fn() })),
      frameLoop: vi.fn(() => ({ stop })),
    },
    dispose: vi.fn(),
  };
  return { instance, surface, stop };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

test('dispose during init cleans a late GPU without starting a loop', async () => {
  const { canvas } = browser();
  const pending = deferred<ReturnType<typeof gpu>['instance']>();
  mocks.init.mockReturnValueOnce(pending.promise);
  const renderer = createRenderer({ canvas });
  await vi.waitFor(() => expect(mocks.init).toHaveBeenCalledOnce());
  renderer.dispose();
  renderer.dispose();
  const late = gpu();
  pending.resolve(late.instance);
  await renderer.ready;
  expect(late.instance.dispose).toHaveBeenCalledOnce();
  expect(late.instance.fns.frameLoop).not.toHaveBeenCalled();
});

test('reports an initialization failure once, rejects ready, and self-disposes', async () => {
  const { canvas } = browser();
  const failed = gpu();
  const error = new Error('surface failed');
  failed.instance.fns.surface.mockImplementationOnce(() => { throw error; });
  mocks.init.mockResolvedValueOnce(failed.instance);
  const onError = vi.fn(() => { throw new Error('reporter failed'); });
  const renderer = createRenderer({ canvas, onError });
  await expect(renderer.ready).rejects.toBe(error);
  expect(onError).toHaveBeenCalledOnce();
  expect(failed.instance.dispose).toHaveBeenCalledOnce();
  renderer.dispose();
  expect(failed.instance.dispose).toHaveBeenCalledOnce();
});

test('drains and settles submitted work when thumbnail rendering throws', async () => {
  const error = new Error('render failed');
  const drainPending = deferred<void>();
  const settledPending = deferred<void>();
  const drain = vi.fn(() => drainPending.promise);
  const settled = vi.fn(() => settledPending.promise);
  const thumbnailGpu = {
    gpu: { queue: { onSubmittedWorkDone: drain } },
    settled,
    fns: {
      effect: vi.fn(() => ({ set: vi.fn() })),
      frame: vi.fn(() => { throw error; }),
    },
  };
  const target = { size: [160, 90] };
  const rendering = renderThumbnail(thumbnailGpu as never, target as never);
  let completed = false;
  void rendering.then(() => { completed = true; }, () => { completed = true; });
  await vi.waitFor(() => {
    expect(drain).toHaveBeenCalledOnce();
    expect(settled).toHaveBeenCalledOnce();
  });
  expect(completed).toBe(false);
  drainPending.resolve();
  settledPending.resolve();
  await expect(rendering).rejects.toBe(error);
});

test('owns one loop, applies the latest coalesced resize, and removes resources', async () => {
  const { canvas, listeners, frames, disconnect } = browser();
  const live = gpu();
  mocks.init.mockResolvedValueOnce(live.instance);
  const renderer = createRenderer({ canvas });
  await renderer.ready;
  expect(live.instance.fns.frameLoop).toHaveBeenCalledOnce();
  renderer.resize({ width: 200, height: 100, dpr: 1 });
  renderer.resize({ width: 300, height: 150, dpr: 2 });
  expect(frames.size).toBe(1);
  [...frames.values()][0]?.(16);
  expect(live.surface.resize).toHaveBeenCalledOnce();
  expect(live.surface.resize).toHaveBeenCalledWith([600, 300]);
  renderer.dispose();
  renderer.dispose();
  expect(live.stop).toHaveBeenCalledOnce();
  expect(live.surface.dispose).toHaveBeenCalledOnce();
  expect(disconnect).toHaveBeenCalledOnce();
  expect(listeners.size).toBe(0);
});
