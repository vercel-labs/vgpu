/**
 * Renderer lifecycle, against a mocked `vgpu`. This is the half of the example
 * that has nothing to do with optics: one frame loop, one accumulation buffer
 * pair, coalesced resizes, and a teardown that releases everything even when
 * initialization loses a race with `dispose()`.
 *
 * The physics is covered by `optics.test.ts` and, on a real device, by
 * `examples/prism-validation`.
 */

import { afterEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ init: vi.fn() }));
const vgpuFns = vi.hoisted(() => Object.fromEntries(
  ['surface', 'target', 'effect', 'draw', 'geometry', 'sampler', 'bundle', 'compute', 'storage', 'uniforms', 'timer', 'visibility', 'pingPong', 'pingPongStorage', 'frame', 'frameLoop']
    // Each test's gpu double carries its factory fakes in `fns`; these route the free functions to them.
    .map((name) => [name, (gpu: any, ...args: any[]) => gpu.fns[name](...args)]),
)) as Record<string, unknown>;
vi.mock('vgpu', () => ({ init: mocks.init, ...vgpuFns, clock: (gpu: any) => gpu.clock ?? { time: 0, deltaTime: 0, frameCount: 0, advance() {} } }));

import { createRenderer } from './renderer';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function browser() {
  const windowListeners = new Map<string, EventListener>();
  const canvasListeners = new Map<string, EventListener>();
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  vi.stubGlobal('window', {
    devicePixelRatio: 2,
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

  const captured = new Set<number>();
  const canvas = {
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 200, height: 100 }),
    addEventListener: vi.fn((name: string, listener: EventListener) => canvasListeners.set(name, listener)),
    removeEventListener: vi.fn((name: string) => canvasListeners.delete(name)),
    setPointerCapture: vi.fn((id: number) => captured.add(id)),
    hasPointerCapture: vi.fn((id: number) => captured.has(id)),
    releasePointerCapture: vi.fn((id: number) => captured.delete(id)),
  } as unknown as HTMLCanvasElement;
  return { canvas, canvasListeners, windowListeners, frames, disconnect };
}

function gpu() {
  const stop = vi.fn();
  const surface = {
    size: [200, 100] as number[],
    format: 'bgra8unorm',
    // Mirrors the real surface: a resize changes the size the scene is sized from.
    resize: vi.fn((size: number[]) => { surface.size = size; }),
    dispose: vi.fn(),
  };
  const pairs: { read: { destroy: ReturnType<typeof vi.fn> }; write: { destroy: ReturnType<typeof vi.fn> }; swap: ReturnType<typeof vi.fn> }[] = [];
  const effects: { set: ReturnType<typeof vi.fn>; compile: ReturnType<typeof vi.fn> }[] = [];
  const draws: { set: ReturnType<typeof vi.fn>; compile: ReturnType<typeof vi.fn> }[] = [];
  const targets: { size: number[]; resize: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> }[] = [];
  const pipeline = (into: { set: ReturnType<typeof vi.fn>; compile: ReturnType<typeof vi.fn> }[]) => {
    const created = { set: vi.fn(), compile: vi.fn(async () => {}) };
    into.push(created);
    return created;
  };
  const instance = {
    gpu: { queue: { onSubmittedWorkDone: vi.fn(async () => {}) } },
    settled: vi.fn(async () => {}),
    dispose: vi.fn(),
    fns: {
      surface: vi.fn(() => surface),
      sampler: vi.fn(() => ({})),
      geometry: vi.fn(() => ({ destroy: vi.fn() })),
      pingPong: vi.fn(() => {
        const pair = {
          read: { size: [120, 60], texelSize: [1 / 120, 1 / 60], destroy: vi.fn(), readFloats: vi.fn() },
          write: { size: [120, 60], texelSize: [1 / 120, 1 / 60], destroy: vi.fn(), readFloats: vi.fn() },
          swap: vi.fn(),
        };
        pairs.push(pair);
        return pair;
      }),
      target: vi.fn((options: { size: number[] }) => {
        const created = {
          size: [...options.size],
          format: 'bgra8unorm',
          resize: vi.fn((size: number[]) => { created.size = [...size]; }),
          destroy: vi.fn(),
        };
        targets.push(created);
        return created;
      }),
      effect: vi.fn(() => pipeline(effects)),
      draw: vi.fn(() => pipeline(draws)),
      // The free functions are routed with `gpu` stripped, so these fakes see
      // only the arguments after it.
      frame: vi.fn((callback: (frame: unknown) => void) => callback({
        pass: (_options: unknown, body: (pass: unknown) => void) => body({ draw: vi.fn() }),
      })),
      frameLoop: vi.fn((_tick: () => void) => ({ stop })),
    },
  };
  return { instance, surface, pairs, effects, draws, targets, stop };
}

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

test('traces and presents once per frame until the estimate has converged', async () => {
  const env = browser();
  const live = gpu();
  mocks.init.mockResolvedValueOnce(live.instance);
  const renderer = createRenderer({ canvas: env.canvas });
  await renderer.ready;

  expect(live.instance.fns.frameLoop).toHaveBeenCalledOnce();
  expect(live.instance.fns.pingPong).toHaveBeenCalledOnce();
  // Every pipeline is pre-warmed before the loop starts, against the target each
  // of them actually draws into: trace and present as effects, wall and glass as
  // draws.
  expect(live.effects).toHaveLength(2);
  expect(live.draws).toHaveLength(2);
  for (const created of [...live.effects, ...live.draws]) expect(created.compile).toHaveBeenCalledOnce();
  // The wall is rasterized offscreen so the glass can sample it while drawing
  // over the copy.
  expect(live.targets).toHaveLength(1);

  const tick = live.instance.fns.frameLoop.mock.calls[0]![0];
  tick();
  expect(renderer.accumulated()).toBe(1);
  // One trace pass and one present pass, and the pair swapped between them.
  expect(live.instance.fns.frame).toHaveBeenCalledTimes(2);
  expect(live.pairs[0]!.swap).toHaveBeenCalledOnce();

  tick();
  expect(renderer.accumulated()).toBe(2);
  renderer.dispose();
});

test('a pointer drag swings the lamp and restarts the average', async () => {
  const env = browser();
  const live = gpu();
  mocks.init.mockResolvedValueOnce(live.instance);
  const renderer = createRenderer({ canvas: env.canvas });
  await renderer.ready;
  const tick = live.instance.fns.frameLoop.mock.calls[0]![0];
  tick();
  tick();
  expect(renderer.accumulated()).toBe(2);

  env.canvasListeners.get('pointerdown')?.({ isPrimary: true, pointerId: 4, clientY: 10 } as unknown as Event);
  expect(env.canvas.setPointerCapture).toHaveBeenCalledWith(4);
  // Aiming somewhere new invalidates every ray already averaged.
  expect(renderer.accumulated()).toBe(0);

  env.canvasListeners.get('pointermove')?.({ pointerId: 4, clientY: 90 } as unknown as Event);
  tick();
  expect(renderer.accumulated()).toBe(1);
  // A move from a pointer we never captured is ignored.
  env.canvasListeners.get('pointermove')?.({ pointerId: 9, clientY: 20 } as unknown as Event);
  expect(renderer.accumulated()).toBe(1);

  env.canvasListeners.get('pointerup')?.({ pointerId: 4 } as unknown as Event);
  expect(env.canvas.releasePointerCapture).toHaveBeenCalledWith(4);
  renderer.dispose();
});

test('changing the glass restarts the average, changing the layer does not', async () => {
  const env = browser();
  const live = gpu();
  mocks.init.mockResolvedValueOnce(live.instance);
  const renderer = createRenderer({ canvas: env.canvas });
  await renderer.ready;
  const tick = live.instance.fns.frameLoop.mock.calls[0]![0];
  tick();
  tick();

  // Peeling a layer off only changes how the same accumulation is composited.
  renderer.setControls?.({ dispersion: 'stylized', view: 'caustic' });
  expect(renderer.accumulated()).toBe(2);
  // A different index of refraction makes every averaged ray wrong.
  renderer.setControls?.({ dispersion: 'flint', view: 'caustic' });
  expect(renderer.accumulated()).toBe(0);
  renderer.dispose();
});

test('the camera follows the pointer without invalidating the estimate', async () => {
  const env = browser();
  const live = gpu();
  mocks.init.mockResolvedValueOnce(live.instance);
  const renderer = createRenderer({ canvas: env.canvas });
  await renderer.ready;
  const tick = live.instance.fns.frameLoop.mock.calls[0]![0];
  tick();
  tick();

  // Hovering — no capture, no drag — aims the camera somewhere new. The caustic
  // lives on the wall in world space, so none of it goes stale.
  env.canvasListeners.get('pointermove')?.({ pointerId: 7, clientX: 180, clientY: 20 } as unknown as Event);
  expect(renderer.accumulated()).toBe(2);
  tick();
  expect(renderer.accumulated()).toBe(3);
  renderer.dispose();
});

test('coalesces resizes, rebuilds the buffer pair, and destroys the old one', async () => {
  const env = browser();
  const live = gpu();
  mocks.init.mockResolvedValueOnce(live.instance);
  const renderer = createRenderer({ canvas: env.canvas });
  await renderer.ready;

  renderer.resize({ width: 300, height: 150, dpr: 1.6 });
  renderer.resize({ width: 900, height: 500, dpr: 2 });
  // Two requests, one animation frame: the last size wins.
  expect(env.frames.size).toBe(1);
  [...env.frames.values()][0]?.(16);
  expect(live.surface.resize).toHaveBeenCalledOnce();
  expect(live.surface.resize).toHaveBeenCalledWith([1800, 1000]);

  expect(live.instance.fns.pingPong).toHaveBeenCalledTimes(2);
  for (const half of [live.pairs[0]!.read, live.pairs[0]!.write]) expect(half.destroy).toHaveBeenCalledOnce();
  for (const half of [live.pairs[1]!.read, live.pairs[1]!.write]) expect(half.destroy).not.toHaveBeenCalled();

  renderer.dispose();
  renderer.dispose();
  expect(live.stop).toHaveBeenCalledOnce();
  expect(env.disconnect).toHaveBeenCalledOnce();
  expect(live.surface.dispose).toHaveBeenCalledOnce();
  expect(live.instance.dispose).toHaveBeenCalledOnce();
  expect(env.canvasListeners.size).toBe(0);
  expect(env.windowListeners.size).toBe(0);
  for (const half of [live.pairs[1]!.read, live.pairs[1]!.write]) expect(half.destroy).toHaveBeenCalledOnce();
});

test('dispose during init cleans up a late GPU without starting a loop', async () => {
  const env = browser();
  const pending = deferred<ReturnType<typeof gpu>['instance']>();
  mocks.init.mockReturnValueOnce(pending.promise);
  const renderer = createRenderer({ canvas: env.canvas });
  await vi.waitFor(() => expect(mocks.init).toHaveBeenCalledOnce());
  renderer.dispose();
  const late = gpu();
  pending.resolve(late.instance);
  await renderer.ready;
  expect(late.instance.dispose).toHaveBeenCalledOnce();
  expect(late.instance.fns.frameLoop).not.toHaveBeenCalled();
});

test('reports an initialization failure once, rejects ready, and self-disposes', async () => {
  const env = browser();
  const failed = gpu();
  const error = new Error('surface failed');
  failed.instance.fns.surface.mockImplementationOnce(() => { throw error; });
  mocks.init.mockResolvedValueOnce(failed.instance);
  const onError = vi.fn(() => { throw new Error('reporter failed'); });
  const renderer = createRenderer({ canvas: env.canvas, onError });
  await expect(renderer.ready).rejects.toBe(error);
  expect(onError).toHaveBeenCalledOnce();
  expect(failed.instance.dispose).toHaveBeenCalledOnce();
  renderer.dispose();
  expect(failed.instance.dispose).toHaveBeenCalledOnce();
});
