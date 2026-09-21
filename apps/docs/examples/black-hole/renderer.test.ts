import { afterEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ init: vi.fn() }));
const vgpuFns = vi.hoisted(
  () =>
    Object.fromEntries(
      [
        'surface',
        'target',
        'effect',
        'draw',
        'geometry',
        'sampler',
        'bundle',
        'compute',
        'storage',
        'uniforms',
        'timer',
        'visibility',
        'pingPong',
        'pingPongStorage',
        'frame',
        'frameLoop',
      ].map((name) => [
        name,
        // Each test's GPU double carries its factory fakes in `fns`.
        (gpu: any, ...args: any[]) => gpu.fns[name](...args),
      ]),
    ) as Record<string, unknown>,
);

vi.mock('vgpu', () => ({
  init: mocks.init,
  ...vgpuFns,
  clock: (gpu: any) =>
    gpu.clock ?? {
      time: 0,
      deltaTime: 0,
      frameCount: 0,
      advance() {},
    },
}));

import { renderThumbnail } from './render-thumbnail';
import { createRenderer } from './renderer';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function setup(options: { failCompile?: boolean } = {}) {
  const windowListeners = new Map<string, EventListener>();
  const canvasListeners = new Map<string, EventListener>();
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  vi.stubGlobal('window', {
    devicePixelRatio: 2,
    addEventListener: vi.fn((name: string, listener: EventListener) => {
      windowListeners.set(name, listener);
    }),
    removeEventListener: vi.fn((name: string) => windowListeners.delete(name)),
  });
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn((callback: FrameRequestCallback) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    }),
  );
  vi.stubGlobal('cancelAnimationFrame', vi.fn((id: number) => frames.delete(id)));
  const disconnect = vi.fn();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe = vi.fn();
      disconnect = disconnect;
    },
  );

  const captured = new Set<number>();
  const canvas = {
    style: { touchAction: 'pan-y' },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 200, height: 100 }),
    addEventListener: vi.fn((name: string, listener: EventListener) => {
      canvasListeners.set(name, listener);
    }),
    removeEventListener: vi.fn((name: string) => canvasListeners.delete(name)),
    setPointerCapture: vi.fn((id: number) => captured.add(id)),
    hasPointerCapture: vi.fn((id: number) => captured.has(id)),
    releasePointerCapture: vi.fn((id: number) => captured.delete(id)),
  } as unknown as HTMLCanvasElement;

  const targetObjects: Array<{
    size: number[];
    texelSize: number[];
    resize: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
    format: string;
    color: { read: ReturnType<typeof vi.fn> };
  }> = [];
  const effects: Array<{ set: ReturnType<typeof vi.fn>; compile: ReturnType<typeof vi.fn> }> = [];
  const surface = { size: [200, 100], format: 'bgra8unorm', dispose: vi.fn() };
  const compile = options.failCompile
    ? vi.fn(async () => {
        throw new Error('compile failed');
      })
    : vi.fn(async () => {});
  const effect = () => {
    const value = { set: vi.fn(), compile };
    effects.push(value);
    return value;
  };
  const stop = vi.fn();
  let liveFrame: ((frame: { pass: ReturnType<typeof vi.fn> }) => void) | undefined;
  const gpu = {
    time: 0,
    gpu: { queue: { onSubmittedWorkDone: vi.fn(async () => {}) } },
    settled: vi.fn(async () => {}),
    dispose: vi.fn(),
    fns: {
      surface: vi.fn(() => surface),
      target: vi.fn(() => {
        const target = {
          size: [200, 100],
          texelSize: [1 / 200, 1 / 100],
          resize: vi.fn(),
          destroy: vi.fn(),
          format: 'rgba16float',
          color: { read: vi.fn(async () => new Uint8Array()) },
        };
        targetObjects.push(target);
        return target;
      }),
      effect: vi.fn(effect),
      sampler: vi.fn(() => ({})),
      frame: vi.fn(),
      frameLoop: vi.fn((callback: NonNullable<typeof liveFrame>) => {
        liveFrame = callback;
        return { stop };
      }),
    },
  };
  mocks.init.mockResolvedValueOnce(gpu);
  return {
    canvas,
    canvasListeners,
    windowListeners,
    frames,
    disconnect,
    effects,
    targetObjects,
    surface,
    gpu,
    stop,
    runFrame: () => liveFrame?.({ pass: vi.fn() }),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

test('coalesces resize work, cleans browser state, and delegates VGPU teardown', async () => {
  const env = setup();
  const renderer = createRenderer({ canvas: env.canvas });
  await renderer.ready;
  expect(env.gpu.fns.frameLoop).toHaveBeenCalledOnce();
  expect(env.canvasListeners.has('pointermove')).toBe(true);

  env.canvasListeners
    .get('pointerdown')
    ?.({ isPrimary: true, pointerId: 7 } as unknown as Event);
  expect(env.canvas.setPointerCapture).toHaveBeenCalledWith(7);
  env.canvasListeners.get('pointermove')?.({
    isPrimary: true,
    pointerId: 7,
    clientX: 0,
    clientY: 100,
  } as unknown as Event);
  env.runFrame();
  const pointer = env.effects[0].set.mock.calls.at(-1)?.[0].params.pointer;
  expect(pointer[0]).toBeCloseTo(Math.PI * 0.7 * 0.12);
  expect(pointer[1]).toBeCloseTo(0.05 + (Math.PI * 0.35 - 0.05) * 0.12);
  renderer.resize({ width: 300, height: 150, dpr: 1.6 });
  renderer.resize({ width: 400, height: 200, dpr: 1.6 });
  expect(env.frames.size).toBe(1);
  [...env.frames.values()][0]?.(16);
  expect(env.gpu.fns.target).toHaveBeenCalledTimes(6);
  for (const target of env.targetObjects.slice(0, 3)) {
    expect(target.destroy).toHaveBeenCalledOnce();
  }
  for (const target of env.targetObjects.slice(3)) {
    expect(target.destroy).not.toHaveBeenCalled();
  }

  renderer.dispose();
  renderer.dispose();
  expect(env.stop).not.toHaveBeenCalled();
  expect(env.disconnect).toHaveBeenCalledOnce();
  expect(env.canvas.releasePointerCapture).toHaveBeenCalledWith(7);
  expect(env.canvas.style.touchAction).toBe('pan-y');
  expect(env.canvasListeners.size).toBe(0);
  expect(env.windowListeners.size).toBe(0);
  expect(env.surface.dispose).not.toHaveBeenCalled();
  expect(env.gpu.dispose).toHaveBeenCalledOnce();
  for (const target of env.targetObjects.slice(0, 3)) {
    expect(target.destroy).toHaveBeenCalledOnce();
  }
  for (const target of env.targetObjects.slice(3)) {
    expect(target.destroy).not.toHaveBeenCalled();
  }
});

test('disposes a stale GPU initialization without creating resources', async () => {
  const env = setup();
  const init = deferred<typeof env.gpu>();
  mocks.init.mockReset().mockReturnValueOnce(init.promise);
  const renderer = createRenderer({ canvas: env.canvas });
  await vi.waitFor(() => expect(mocks.init).toHaveBeenCalledOnce());
  renderer.dispose();
  init.resolve(env.gpu);
  await renderer.ready;
  expect(env.gpu.dispose).toHaveBeenCalledOnce();
  expect(env.gpu.fns.surface).not.toHaveBeenCalled();
});

test('initialization failure delegates resource teardown to the GPU', async () => {
  const env = setup({ failCompile: true });
  const renderer = createRenderer({ canvas: env.canvas });
  await expect(renderer.ready).rejects.toThrow('compile failed');
  expect(env.surface.dispose).not.toHaveBeenCalled();
  expect(env.gpu.dispose).toHaveBeenCalledOnce();
  for (const target of env.targetObjects) {
    expect(target.destroy).not.toHaveBeenCalled();
  }
});

test.each(['effect construction', 'prewarm'])('thumbnail destroys its target graph when %s fails', async (stage) => {
  const env = setup({ failCompile: stage === 'prewarm' });
  const message = stage === 'prewarm' ? 'compile failed' : 'effect construction failed';
  if (stage === 'effect construction') {
    env.gpu.fns.effect.mockImplementationOnce(() => {
      throw new Error(message);
    });
  }
  const output = {
    size: [160, 90],
    format: 'rgba8unorm',
    color: { read: vi.fn(async () => new Uint8Array()) },
  };
  const drainPending = deferred<void>();
  const settledPending = deferred<void>();
  env.gpu.gpu.queue.onSubmittedWorkDone.mockReturnValueOnce(drainPending.promise);
  env.gpu.settled.mockReturnValueOnce(settledPending.promise);
  const rendering = renderThumbnail(env.gpu as never, output as never);
  await vi.waitFor(() => {
    expect(env.gpu.gpu.queue.onSubmittedWorkDone).toHaveBeenCalledOnce();
    expect(env.gpu.settled).toHaveBeenCalledOnce();
  });
  expect(env.targetObjects).toHaveLength(3);
  for (const target of env.targetObjects) {
    expect(target.destroy).not.toHaveBeenCalled();
  }
  drainPending.resolve();
  settledPending.resolve();
  await expect(rendering).rejects.toThrow(message);
  for (const target of env.targetObjects) {
    expect(target.destroy).toHaveBeenCalledOnce();
  }
});
