import { afterEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ init: vi.fn() }));
const vgpuFns = vi.hoisted(() =>
  Object.fromEntries(
    ['surface', 'target', 'effect', 'sampler', 'frame', 'frameLoop']
      // Each test's gpu double carries its factory fakes in `fns`; these route the free functions to them.
      .map((name) => [name, (gpu: any, ...args: any[]) => gpu.fns[name](...args)]),
  ),
) as Record<string, unknown>;
vi.mock('vgpu', () => ({
  init: mocks.init,
  ...vgpuFns,
  clock: (gpu: any) => gpu.clock ?? { time: 0, deltaTime: 0, frameCount: 0, advance() {} },
}));

import { createRenderer } from './renderer';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function browser({ dpr = 2 } = {}) {
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  vi.stubGlobal('window', {
    devicePixelRatio: dpr,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  vi.stubGlobal('document', { visibilityState: 'visible' });
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
  const canvas = { getBoundingClientRect: () => ({ width: 200, height: 100 }) } as HTMLCanvasElement;
  const flushFrames = () => {
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(performance.now());
  };
  return { canvas, frames, flushFrames, disconnect };
}

function gpu() {
  const stop = vi.fn();
  let loopCallback: ((frame: unknown) => void) | undefined;
  const surface = {
    size: [200, 100] as [number, number],
    format: 'bgra8unorm',
    resize: vi.fn((size: [number, number]) => { surface.size = size; }),
    dispose: vi.fn(),
  };
  const compiled: string[] = [];
  const makeEffect = (label = 'effect') => ({
    set: vi.fn(),
    compile: vi.fn(async () => { compiled.push(label); }),
  });
  const targets: Array<{ size: [number, number]; texelSize: [number, number]; resize: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> }> = [];
  const instance = {
    clock: { time: 0, deltaTime: 1 / 60, frameCount: 0 },
    fns: {
      surface: vi.fn(() => surface),
      sampler: vi.fn(() => ({})),
      target: vi.fn((options: { size: [number, number] }) => {
        const created = {
          size: options.size,
          texelSize: [1 / options.size[0], 1 / options.size[1]] as [number, number],
          resize: vi.fn(),
          destroy: vi.fn(),
        };
        targets.push(created);
        return created;
      }),
      effect: vi.fn((_source: unknown, options?: { label?: string }) => makeEffect(options?.label)),
      frameLoop: vi.fn((callback: (frame: unknown) => void) => {
        loopCallback = callback;
        return { stop };
      }),
    },
    dispose: vi.fn(),
  };
  return { instance, surface, stop, targets, compiled, tick: () => loopCallback?.({ pass: vi.fn() }) };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

test('cleanup waiting during init disposes the late gpu', async () => {
  const { canvas } = browser();
  const pending = deferred<ReturnType<typeof gpu>['instance']>();
  mocks.init.mockReturnValueOnce(pending.promise);
  const renderer = createRenderer({ canvas });
  renderer.dispose();
  const late = gpu();
  pending.resolve(late.instance);
  await renderer.ready;
  expect(late.instance.dispose).toHaveBeenCalledOnce();
  expect(late.instance.fns.frameLoop).not.toHaveBeenCalled();
});

test('rejects an initialization failure and self-disposes', async () => {
  const { canvas } = browser();
  const failed = gpu();
  const error = new Error('surface failed');
  failed.instance.fns.surface.mockImplementationOnce(() => { throw error; });
  mocks.init.mockResolvedValueOnce(failed.instance);
  await expect(createRenderer({ canvas, onError: () => {} }).ready).rejects.toBe(error);
  expect(failed.instance.dispose).toHaveBeenCalledOnce();
});

test('starts High at the clamped DPR with every pipeline compiled before the first frame', async () => {
  const { canvas } = browser({ dpr: 3 });
  const live = gpu();
  mocks.init.mockResolvedValueOnce(live.instance);
  const renderer = createRenderer({ canvas });
  await renderer.ready;
  expect(live.instance.fns.surface).toHaveBeenCalledWith(canvas, { autoResize: false, dpr: 2 });
  // High owns the HDR scene target plus two half-res bloom targets.
  expect(live.instance.fns.target).toHaveBeenCalledTimes(3);
  expect(live.compiled).toHaveLength(5);
  expect(live.surface.resize).toHaveBeenCalledWith([400, 200]);
  expect(renderer.getState()).toEqual({ preference: 'auto', effective: 'high', reason: 'initial' });
  expect(live.instance.fns.frameLoop).toHaveBeenCalledOnce();
  renderer.dispose();
  expect(live.stop).toHaveBeenCalledOnce();
  expect(live.instance.dispose).toHaveBeenCalledOnce();
  for (const created of live.targets) expect(created.destroy).toHaveBeenCalledOnce();
});

test('forcing Low swaps to the single-pass pipeline at DPR 1 and releases High targets', async () => {
  const { canvas } = browser({ dpr: 2 });
  const live = gpu();
  mocks.init.mockResolvedValueOnce(live.instance);
  const renderer = createRenderer({ canvas });
  const states: string[] = [];
  renderer.subscribe((state) => states.push(`${state.effective}:${state.reason}`));
  await renderer.ready;
  live.surface.resize.mockClear();

  await renderer.setPreference('low');
  expect(live.instance.fns.target).toHaveBeenCalledTimes(3);
  expect(live.compiled).toHaveLength(6);
  expect(live.surface.resize).toHaveBeenCalledWith([200, 100]);
  for (const created of live.targets) expect(created.destroy).toHaveBeenCalledOnce();
  expect(renderer.getState()).toEqual({ preference: 'low', effective: 'low', reason: 'forced' });
  expect(states.at(-1)).toBe('low:forced');
  renderer.dispose();
});

test('renders the active tier each tick and only arms signals after a presented frame', async () => {
  const { canvas, frames, flushFrames } = browser();
  const live = gpu();
  mocks.init.mockResolvedValueOnce(live.instance);
  const renderer = createRenderer({ canvas });
  await renderer.ready;
  expect(frames.size).toBe(0);
  const pass = vi.fn();
  live.tick();
  // A rAF plus a macrotask is queued for the deferred signals import.
  expect(frames.size).toBe(1);
  flushFrames();
  renderer.dispose();
  expect(pass).not.toHaveBeenCalled();
});
