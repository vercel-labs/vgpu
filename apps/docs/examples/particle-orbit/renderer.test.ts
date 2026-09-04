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
vi.mock('vgpu/scene', () => ({ box: vi.fn(() => ({})) }));

const dustMocks = vi.hoisted(() => ({
  buffer: { label: 'typegpu-particles' },
  update: vi.fn(),
  destroy: vi.fn(),
  setLightField: vi.fn(),
  create: vi.fn(),
}));
vi.mock('./dust', () => ({
  createDust: dustMocks.create.mockImplementation(() => ({
    buffer: dustMocks.buffer,
    update: dustMocks.update,
    destroy: dustMocks.destroy,
    setLightField: dustMocks.setLightField,
  })),
}));

import {
  radianceCascadeCount,
  radianceFieldSize,
  radianceJumps,
} from './radiance';
import { renderThumbnail } from './render-thumbnail';
import { createRenderer } from './renderer';

// emitter + jfa-init + sdf-finalize + resolve, plus one effect per jump and cascade.
function radianceEffectCount(screen: [number, number]) {
  const size = radianceFieldSize(screen);
  return 4 + radianceJumps(size).length + radianceCascadeCount(size);
}
// emitter, jfa ping-pong, sdf, two cascade atlases, irradiance.
const RADIANCE_TARGETS = 7;
const BASE_TARGETS = 4;
const GENERATION_TARGETS = BASE_TARGETS + RADIANCE_TARGETS;

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

  const canvas = {
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 200, height: 100 }),
    addEventListener: vi.fn((name: string, listener: EventListener) => {
      canvasListeners.set(name, listener);
    }),
    removeEventListener: vi.fn((name: string) => canvasListeners.delete(name)),
  } as unknown as HTMLCanvasElement;

  const targetObjects: Array<{
    size: number[];
    texelSize: number[];
    destroy: ReturnType<typeof vi.fn>;
    format: string;
  }> = [];
  const effects: Array<{ set: ReturnType<typeof vi.fn>; compile: ReturnType<typeof vi.fn> }> = [];
  const draws: Array<{ set: ReturnType<typeof vi.fn>; compile: ReturnType<typeof vi.fn> }> = [];
  const surface = { size: [200, 100], format: 'bgra8unorm', dispose: vi.fn() };
  const compile = options.failCompile
    ? vi.fn(async () => {
        throw new Error('compile failed');
      })
    : vi.fn(async () => {});
  const pipeline = (bucket: typeof effects) => () => {
    const value = { set: vi.fn(), compile };
    bucket.push(value);
    return value;
  };
  const bundleRecorder = { draw: vi.fn() };
  const sceneBundle = {};
  const stop = vi.fn();
  let liveFrame: ((frame: { pass: ReturnType<typeof vi.fn> }) => void) | undefined;
  const wrappedBuffer = { dispose: vi.fn() };
  const gpu = {
    gpu: { queue: { onSubmittedWorkDone: vi.fn(async () => {}) } },
    device: { wrapBuffer: vi.fn(() => wrappedBuffer) },
    settled: vi.fn(async () => {}),
    dispose: vi.fn(),
    fns: {
      surface: vi.fn(() => surface),
      target: vi.fn((_options: unknown) => {
        const target = {
          size: [200, 100],
          texelSize: [1 / 200, 1 / 100],
          color: { view: {} },
          destroy: vi.fn(),
          format: 'rgba16float',
        };
        targetObjects.push(target);
        return target;
      }),
      effect: vi.fn(pipeline(effects)),
      draw: vi.fn(pipeline(draws)),
      geometry: vi.fn(() => ({})),
      sampler: vi.fn(() => ({})),
      bundle: vi.fn((_opts: unknown, record: (pass: typeof bundleRecorder) => void) => {
        record(bundleRecorder);
        return sceneBundle;
      }),
      frame: vi.fn((callback: NonNullable<typeof liveFrame>) => {
        callback({ pass: vi.fn() });
      }),
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
    wrappedBuffer,
    windowListeners,
    frames,
    disconnect,
    effects,
    draws,
    bundleRecorder,
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

test('builds the pipeline, records the scene bundle, drives time, and coalesces resizes', async () => {
  const env = setup();
  const renderer = createRenderer({ canvas: env.canvas });
  await renderer.ready;
  expect(mocks.init).toHaveBeenCalledWith({
    requiredLimits: { maxStorageBuffersInVertexStage: 1 },
  });
  expect(env.gpu.fns.frameLoop).toHaveBeenCalledOnce();
  // nebula, atmosphere, bright, 4× blur, post, plus the radiance chain.
  expect(env.gpu.fns.effect).toHaveBeenCalledTimes(8 + radianceEffectCount([200, 100]));
  // stars and trails.
  expect(env.gpu.fns.draw).toHaveBeenCalledTimes(2);
  expect(env.gpu.fns.geometry).not.toHaveBeenCalled();
  expect(env.gpu.fns.bundle).toHaveBeenCalledOnce();
  expect(env.bundleRecorder.draw).toHaveBeenCalledTimes(2);
  expect(env.canvasListeners.has('pointermove')).toBe(true);
  // TypeGPU shares the device; its particle buffer is wrapped zero-copy.
  expect(dustMocks.create).toHaveBeenCalledWith(env.gpu.gpu);
  expect(env.gpu.device.wrapBuffer).toHaveBeenCalledWith(dustMocks.buffer);
  expect(dustMocks.setLightField).toHaveBeenCalledOnce();

  // TypeGPU advances the simulation; vgpu renders the wrapped buffer.
  env.runFrame();
  expect(dustMocks.update).toHaveBeenCalledOnce();
  for (const pipeline of env.draws) {
    expect(pipeline.set).toHaveBeenCalledWith({ params: { time: 0 } });
  }
  // nebula, atmosphere, post, and the radiance emitter are time-driven.
  const [nebula, atmosphere] = env.effects;
  const post = env.effects[7];
  const rcEmitter = env.effects[8];
  for (const pipeline of [nebula, atmosphere, post, rcEmitter]) {
    expect(pipeline.set).toHaveBeenCalledWith({ params: { time: 0 } });
  }
  expect(post.set).toHaveBeenCalledWith({ params: { pointer: [0, 0] } });

  renderer.resize({ width: 300, height: 150, dpr: 1.6 });
  renderer.resize({ width: 400, height: 200, dpr: 1.6 });
  expect(env.frames.size).toBe(1);
  [...env.frames.values()][0]?.(16);
  // Each generation: scene, composite, two bloom targets, and the light field.
  expect(env.gpu.fns.target).toHaveBeenCalledTimes(GENERATION_TARGETS * 2);
  for (const target of env.targetObjects.slice(0, GENERATION_TARGETS)) {
    expect(target.destroy).toHaveBeenCalledOnce();
  }
  for (const target of env.targetObjects.slice(GENERATION_TARGETS)) {
    expect(target.destroy).not.toHaveBeenCalled();
  }
  // Resize swaps targets without re-recording the bundle, and rebinds
  // the rebuilt light field into the TypeGPU simulation.
  expect(env.gpu.fns.bundle).toHaveBeenCalledOnce();
  expect(dustMocks.setLightField).toHaveBeenCalledTimes(2);

  renderer.dispose();
  renderer.dispose();
  expect(env.stop).not.toHaveBeenCalled();
  expect(env.disconnect).toHaveBeenCalledOnce();
  expect(env.canvasListeners.size).toBe(0);
  expect(env.windowListeners.size).toBe(0);
  expect(env.surface.dispose).not.toHaveBeenCalled();
  expect(env.gpu.dispose).toHaveBeenCalledOnce();
  expect(env.wrappedBuffer.dispose).toHaveBeenCalledOnce();
  expect(dustMocks.destroy).toHaveBeenCalledOnce();
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
  // The bundle never records when prewarm fails.
  expect(env.gpu.fns.bundle).not.toHaveBeenCalled();
  for (const target of env.targetObjects) {
    expect(target.destroy).not.toHaveBeenCalled();
  }
});

test('thumbnail renders warmup frames against the offscreen graph', async () => {
  const env = setup();
  const output = { size: [160, 90], format: 'rgba8unorm' };
  await renderThumbnail(env.gpu as never, output as never, {
    warmupFrames: 5,
    dt: 1 / 60,
    time: 2,
  });
  expect(env.gpu.fns.frame).toHaveBeenCalledTimes(5);
  expect(dustMocks.update).toHaveBeenCalledTimes(5);
  expect(env.gpu.fns.bundle).toHaveBeenCalledOnce();
  expect(env.gpu.settled).toHaveBeenCalledOnce();
  expect(env.targetObjects).toHaveLength(GENERATION_TARGETS);
  for (const target of env.targetObjects) {
    expect(target.destroy).toHaveBeenCalledOnce();
  }
  expect(env.wrappedBuffer.dispose).toHaveBeenCalledOnce();
  expect(dustMocks.destroy).toHaveBeenCalledOnce();
});

test('thumbnail keeps HDR but disables scene MSAA in compatibility mode', async () => {
  const env = setup();
  Object.assign(env.gpu.device, { isCompatibilityMode: true });
  const output = { size: [160, 90], format: 'rgba8unorm' };

  await renderThumbnail(env.gpu as never, output as never, { warmupFrames: 1 });

  expect(env.gpu.fns.target.mock.calls[0]?.[0]).toMatchObject({
    format: 'rgba16float',
    msaa: false,
  });
  expect(env.gpu.fns.bundle.mock.calls[0]?.[0]).toMatchObject({
    target: { colors: ['rgba16float'], sampleCount: 1 },
  });
});

test('thumbnail destroys its target graph when prewarm fails', async () => {
  const env = setup({ failCompile: true });
  const output = { size: [160, 90], format: 'rgba8unorm' };
  const drainPending = deferred<void>();
  const settledPending = deferred<void>();
  env.gpu.gpu.queue.onSubmittedWorkDone.mockReturnValueOnce(drainPending.promise);
  env.gpu.settled.mockReturnValueOnce(settledPending.promise);
  const rendering = renderThumbnail(env.gpu as never, output as never);
  await vi.waitFor(() => {
    expect(env.gpu.gpu.queue.onSubmittedWorkDone).toHaveBeenCalledOnce();
    expect(env.gpu.settled).toHaveBeenCalledOnce();
  });
  expect(env.targetObjects).toHaveLength(GENERATION_TARGETS);
  for (const target of env.targetObjects) {
    expect(target.destroy).not.toHaveBeenCalled();
  }
  drainPending.resolve();
  settledPending.resolve();
  await expect(rendering).rejects.toThrow('compile failed');
  for (const target of env.targetObjects) {
    expect(target.destroy).toHaveBeenCalledOnce();
  }
});
