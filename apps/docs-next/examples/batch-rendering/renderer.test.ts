import { afterEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ init: vi.fn() }));
const vgpuFns = vi.hoisted(() => Object.fromEntries(
  ['surface', 'target', 'effect', 'draw', 'geometry', 'sampler', 'bundle', 'compute', 'storage', 'uniforms', 'timer', 'visibility', 'pingPong', 'pingPongStorage', 'frame', 'frameLoop']
    // Each test's gpu double carries its factory fakes in `fns`; these route the free functions to them.
    .map((name) => [name, (gpu: any, ...args: any[]) => gpu.fns[name](...args)]),
)) as Record<string, unknown>;
vi.mock('vgpu', () => ({ init: mocks.init, ...vgpuFns, clock: (gpu: any) => gpu.clock ?? { time: 0, deltaTime: 0, frameCount: 0, advance() {} } }));
vi.mock('vgpu/scene', () => ({ perspectiveCamera: () => ({ viewProjection: new Float32Array(16) }) }));

import { createRenderer, renderThumbnail } from './renderer';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function setup() {
  const windowListeners = new Map<string, EventListener>();
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  vi.stubGlobal('window', {
    devicePixelRatio: 1,
    addEventListener: vi.fn((name: string, listener: EventListener) => windowListeners.set(name, listener)),
    removeEventListener: vi.fn((name: string) => windowListeners.delete(name)),
  });
  vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  }));
  vi.stubGlobal('cancelAnimationFrame', vi.fn((id: number) => frames.delete(id)));
  const disconnect = vi.fn();
  vi.stubGlobal('ResizeObserver', class { observe = vi.fn(); disconnect = disconnect; });
  const canvas = { getBoundingClientRect: () => ({ width: 320, height: 180 }) } as HTMLCanvasElement;
  const surface = { size: [320, 180], format: 'bgra8unorm', dispose: vi.fn() };
  const target = { size: [320, 180], format: 'rgba8unorm', resize: vi.fn(), destroy: vi.fn() };
  const geometry = {
    slice: vi.fn(() => ({ firstVertex: 0, vertexCount: 3 })),
    destroy: vi.fn(),
  };
  const draw = () => ({ set: vi.fn(), compile: vi.fn(async () => {}) });
  const stop = vi.fn();
  const drain = vi.fn(async () => {});
  const settled = vi.fn(async () => {});
  const gpu = {
    time: 0,
    gpu: { queue: { onSubmittedWorkDone: drain } },
    settled,
    dispose: vi.fn(), fns: {
    surface: vi.fn(() => surface),
    target: vi.fn(() => target),
    effect: vi.fn(() => ({ set: vi.fn(), compile: vi.fn(async () => {}) })),
    sampler: vi.fn(() => ({})),
    geometry: vi.fn(() => geometry),
    draw: vi.fn(draw),
    bundle: vi.fn(() => ({})),
    frame: vi.fn(),
    frameLoop: vi.fn(() => ({ stop })) }};
  return { canvas, windowListeners, frames, disconnect, surface, target, geometry, stop, drain, settled, gpu };
}

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

test('drains and settles before destroying thumbnail resources after render failure', async () => {
  const env = setup();
  const error = new Error('render failed');
  const drainPending = deferred<void>();
  const settledPending = deferred<void>();
  env.drain.mockReturnValueOnce(drainPending.promise);
  env.settled.mockReturnValueOnce(settledPending.promise);
  env.gpu.fns.frame.mockImplementationOnce(() => { throw error; });
  const output = { size: [160, 90], format: 'rgba8unorm' };
  const rendering = renderThumbnail(env.gpu as never, output as never);
  await vi.waitFor(() => {
    expect(env.drain).toHaveBeenCalledOnce();
    expect(env.settled).toHaveBeenCalledOnce();
  });
  expect(env.geometry.destroy).not.toHaveBeenCalled();
  expect(env.target.destroy).not.toHaveBeenCalled();
  drainPending.resolve();
  settledPending.resolve();
  await expect(rendering).rejects.toBe(error);
  expect(env.geometry.destroy).toHaveBeenCalledOnce();
  expect(env.target.destroy).toHaveBeenCalledOnce();
});

test('owns one loop, coalesces offscreen resize, and disposes twice safely', async () => {
  const env = setup();
  mocks.init.mockResolvedValueOnce(env.gpu);
  const renderer = createRenderer({ canvas: env.canvas });
  await renderer.ready;
  expect(env.gpu.fns.frameLoop).toHaveBeenCalledOnce();
  renderer.resize({ width: 400, height: 200, dpr: 1 });
  renderer.resize({ width: 500, height: 250, dpr: 2 });
  expect(env.frames.size).toBe(1);
  [...env.frames.values()][0]?.(16);
  expect(env.target.resize).toHaveBeenCalledOnce();
  expect(env.target.resize).toHaveBeenCalledWith([1000, 500]);

  renderer.dispose();
  renderer.dispose();
  expect(env.stop).toHaveBeenCalledOnce();
  expect(env.disconnect).toHaveBeenCalledOnce();
  expect(env.geometry.destroy).toHaveBeenCalledOnce();
  expect(env.target.destroy).toHaveBeenCalledOnce();
  expect(env.surface.dispose).toHaveBeenCalledOnce();
  expect(env.windowListeners.size).toBe(0);
});
