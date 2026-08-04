import { afterEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  init: vi.fn(),
  createFluid: vi.fn(() => ({ marker: 'fluid' })),
  destroyFluid: vi.fn(),
  prepareFluid: vi.fn(async () => {}),
  renderFluid: vi.fn(),
  stepFluid: vi.fn(),
  inputDispose: vi.fn(),
}));
const vgpuFns = vi.hoisted(() => Object.fromEntries(
  ['surface', 'target', 'effect', 'draw', 'geometry', 'sampler', 'bundle', 'compute', 'storage', 'uniforms', 'timer', 'visibility', 'pingPong', 'pingPongStorage', 'frame', 'frameLoop']
    // Each test's gpu double carries its factory fakes in `fns`; these route the free functions to them.
    .map((name) => [name, (gpu: any, ...args: any[]) => gpu.fns[name](...args)]),
)) as Record<string, unknown>;
vi.mock('vgpu', () => ({ init: mocks.init, ...vgpuFns, clock: (gpu: any) => gpu.clock ?? { time: 0, deltaTime: 0, frameCount: 0, advance() {} } }));
vi.mock('./simulation', () => ({
  createFluid: mocks.createFluid,
  destroyFluid: mocks.destroyFluid,
  prepareFluid: mocks.prepareFluid,
  renderFluid: mocks.renderFluid,
  stepFluid: mocks.stepFluid,
}));
vi.mock('./pointer-input', () => ({ installStirInput: () => ({ dispose: mocks.inputDispose }) }));

import { createRenderer, renderThumbnail } from './renderer';

function setup() {
  let nextRaf = 1;
  const callbacks = new Map<number, FrameRequestCallback>();
  vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
    const id = nextRaf++;
    callbacks.set(id, callback);
    return id;
  }));
  vi.stubGlobal('cancelAnimationFrame', vi.fn((id: number) => callbacks.delete(id)));
  vi.stubGlobal('performance', { now: () => 0 });
  const page = { hidden: false };
  vi.stubGlobal('document', page);
  const windowMock = { devicePixelRatio: 1, addEventListener: vi.fn(), removeEventListener: vi.fn() };
  vi.stubGlobal('window', windowMock);
  let observerCallback: ResizeObserverCallback | undefined;
  vi.stubGlobal('ResizeObserver', class { constructor(callback: ResizeObserverCallback) { observerCallback = callback; } observe() {} disconnect() {} });
  let surfaceResizeCallback: (() => void) | undefined;
  const surface = { onResize: vi.fn((callback: () => void) => { surfaceResizeCallback = callback; return vi.fn(); }), dispose: vi.fn(), size: [100, 50], format: 'bgra8unorm' };
  const gpu = { dispose: vi.fn() , fns: { surface: vi.fn(() => surface) }};
  mocks.init.mockResolvedValueOnce(gpu);
  const canvas = {
    style: { touchAction: '' },
    getBoundingClientRect: () => ({ width: 100, height: 50 }),
  } as unknown as HTMLCanvasElement;
  const fireNext = (time: number) => {
    const entry = callbacks.entries().next().value as [number, FrameRequestCallback] | undefined;
    if (!entry) return;
    callbacks.delete(entry[0]);
    entry[1](time);
  };
  return {
    page, surface, gpu, canvas, callbacks, fireNext, windowMock,
    surfaceResize: () => surfaceResizeCallback?.(),
    observerResize: () => observerCallback?.([], {} as ResizeObserver),
  };
}

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

test('hidden time is discarded by the fixed-step RAF and disposal cancels future work', async () => {
  const env = setup();
  const renderer = createRenderer({ canvas: env.canvas });
  await renderer.ready;
  env.fireNext(17);
  expect(mocks.stepFluid).toHaveBeenCalledOnce();
  env.page.hidden = true;
  env.fireNext(10_000);
  expect(mocks.stepFluid).toHaveBeenCalledOnce();
  env.page.hidden = false;
  env.fireNext(10_017);
  expect(mocks.stepFluid).toHaveBeenCalledTimes(2);
  renderer.dispose();
  renderer.dispose();
  expect(env.callbacks.size).toBe(0);
  expect(mocks.inputDispose).toHaveBeenCalledOnce();
  expect(env.surface.dispose).toHaveBeenCalledOnce();
  expect(env.gpu.dispose).toHaveBeenCalledOnce();
});

test('all resize sources coalesce and async display preparation never overlaps', async () => {
  const env = setup();
  const renderer = createRenderer({ canvas: env.canvas });
  await renderer.ready;
  expect(mocks.prepareFluid).toHaveBeenCalledTimes(1);

  env.surfaceResize();
  env.observerResize();
  renderer.resize({ width: 200, height: 100, dpr: 2 });
  expect(env.callbacks.size).toBe(2); // fixed-step tick plus one resize flush
  const resizeId = Math.max(...env.callbacks.keys());
  const resizeCallback = env.callbacks.get(resizeId)!;
  env.callbacks.delete(resizeId);
  resizeCallback(1);
  await vi.waitFor(() => expect(mocks.prepareFluid).toHaveBeenCalledTimes(2));

  let release!: () => void;
  mocks.prepareFluid.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
  env.surfaceResize();
  const pendingId = Math.max(...env.callbacks.keys());
  const pendingCallback = env.callbacks.get(pendingId)!;
  env.callbacks.delete(pendingId);
  pendingCallback(2);
  await vi.waitFor(() => expect(mocks.prepareFluid).toHaveBeenCalledTimes(3));
  env.observerResize();
  renderer.resize({ width: 300, height: 150, dpr: 1 });
  expect(env.callbacks.size).toBe(1); // only the fixed-step tick while prepare is running
  release();
  await vi.waitFor(() => expect(mocks.prepareFluid).toHaveBeenCalledTimes(4));

  const dprListener = env.windowMock.addEventListener.mock.calls.find(([type]) => type === 'resize')?.[1] as (() => void);
  env.windowMock.devicePixelRatio = 1.5;
  dprListener();
  expect(env.callbacks.size).toBe(2);
  renderer.dispose();
});

test('thumbnail cleanup waits for submitted work and destroys fluid resources on failure', async () => {
  const failure = new Error('compile failed');
  mocks.prepareFluid.mockRejectedValueOnce(failure);
  const onSubmittedWorkDone = vi.fn(async () => {});
  const gpu = { gpu: { queue: { onSubmittedWorkDone } } };
  await expect(renderThumbnail(gpu as never, {} as never)).rejects.toBe(failure);
  expect(onSubmittedWorkDone).toHaveBeenCalledOnce();
  expect(mocks.destroyFluid).toHaveBeenCalledOnce();
});

test('throwing error reporter cannot replace the original error or bypass full teardown', async () => {
  const env = setup();
  const originalError = new Error('animation scheduling failed');
  const reporterError = new Error('reporter failed');
  const cancelAnimationFrame = vi.fn();
  let requestCount = 0;
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => {
    requestCount++;
    if (requestCount === 2) throw originalError;
    return 41;
  }));
  vi.stubGlobal('cancelAnimationFrame', cancelAnimationFrame);
  env.surface.onResize.mockImplementationOnce((callback: () => void) => {
    callback();
    return vi.fn();
  });
  const onError = vi.fn(() => { throw reporterError; });

  const renderer = createRenderer({ canvas: env.canvas, onError });
  await expect(renderer.ready).rejects.toBe(originalError);

  expect(onError).toHaveBeenCalledOnce();
  expect(onError).toHaveBeenCalledWith(originalError);
  expect(cancelAnimationFrame).toHaveBeenCalledWith(41);
  expect(env.windowMock.removeEventListener).toHaveBeenCalledWith('resize', expect.any(Function));
  expect(mocks.inputDispose).toHaveBeenCalledOnce();
  expect(mocks.destroyFluid).toHaveBeenCalledOnce();
  expect(env.surface.dispose).toHaveBeenCalledOnce();
  expect(env.gpu.dispose).toHaveBeenCalledOnce();
});

test('dispose before GPU readiness prevents installation and disposes the late GPU', async () => {
  const env = setup();
  let resolve!: (gpu: typeof env.gpu) => void;
  mocks.init.mockReset().mockReturnValueOnce(new Promise((done) => { resolve = done; }));
  const renderer = createRenderer({ canvas: env.canvas });
  // Let the dynamic import settle so initialization is waiting on init().
  await vi.waitFor(() => expect(mocks.init).toHaveBeenCalledOnce());
  renderer.dispose();
  resolve(env.gpu);
  await renderer.ready;
  expect(env.gpu.dispose).toHaveBeenCalledOnce();
  expect(env.callbacks.size).toBe(0);
});
