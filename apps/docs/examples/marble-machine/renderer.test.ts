import { afterEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ init: vi.fn() }));
const pipelineMocks = vi.hoisted(() => ({
  createPipeline: vi.fn(),
  encode: vi.fn(),
  publish: vi.fn(),
  resizePipeline: vi.fn(),
  setStudio: vi.fn(),
}));
const guiHarness = vi.hoisted(() => {
  interface Control {
    model: Record<string, unknown>;
    property: string;
    label?: string;
    change?: (value: unknown) => unknown;
    updateDisplay: ReturnType<typeof vi.fn>;
    name(label: string): Control;
    onChange(change: (value: unknown) => unknown): Control;
    enable(enabled?: boolean): Control;
  }
  class FakeGui {
    options: unknown;
    domElement = { style: {} as Record<string, string> };
    destroy = vi.fn();
    close = vi.fn();
    controls: Control[] = [];

    constructor(options: unknown) {
      this.options = options;
      instances.push(this);
    }

    add(model: Record<string, unknown>, property: string): Control {
      const control: Control = {
        model,
        property,
        updateDisplay: vi.fn(),
        name(label) {
          control.label = label;
          return control;
        },
        onChange(change) {
          control.change = change;
          return control;
        },
        enable() {
          return control;
        },
      };
      this.controls.push(control);
      return control;
    }

    control(label: string): Control {
      const found = this.controls.find((candidate) => candidate.label === label);
      if (!found) throw new Error(`No GUI control labelled ${label}`);
      return found;
    }
  }
  const instances: FakeGui[] = [];
  return { FakeGui, instances };
});
const vgpuFns = vi.hoisted(
  () =>
    Object.fromEntries(
      ['surface', 'frame', 'frameLoop'].map((name) => [
        name,
        // Each test's GPU double carries its factory fakes in `fns`.
        (gpu: any, ...args: any[]) => gpu.fns[name](...args),
      ]),
    ) as Record<string, unknown>,
);

vi.mock('lil-gui', () => ({ default: guiHarness.FakeGui }));
vi.mock('vgpu', () => ({
  init: mocks.init,
  ...vgpuFns,
  clock: (gpu: any) => gpu.clock ?? { time: 0, deltaTime: 1 / 60, frameCount: 0 },
}));
vi.mock('./pipeline', () => ({ SHADOW_MAP_SIZE: 2048, ...pipelineMocks }));
vi.mock('./simulation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./simulation')>();
  // The real simulation, observed: tests read the instance the renderer created.
  return { ...actual, createSimulation: vi.fn(actual.createSimulation) };
});

import { renderThumbnail } from './render-thumbnail';
import { createRenderer } from './renderer';
import { createSimulation, type Simulation } from './simulation';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function setup(options: { reducedMotion?: boolean; coarsePointer?: boolean; width?: number } = {}) {
  const motionListeners = new Set<(event: MediaQueryListEvent) => void>();
  const motionQuery = {
    matches: options.reducedMotion ?? false,
    addEventListener: vi.fn((_: string, listener: (event: MediaQueryListEvent) => void) => motionListeners.add(listener)),
    removeEventListener: vi.fn((_: string, listener: (event: MediaQueryListEvent) => void) => motionListeners.delete(listener)),
  };
  vi.stubGlobal('window', {
    matchMedia: vi.fn((query: string) =>
      query === '(prefers-reduced-motion: reduce)' ? motionQuery : { matches: query === '(pointer: coarse)' && (options.coarsePointer ?? false) },
    ),
  });
  const microtasks: Array<() => void> = [];
  vi.stubGlobal('queueMicrotask', (callback: () => void) => microtasks.push(callback));

  const canvasListeners = new Map<string, Set<EventListener>>();
  const container = { tagName: 'DIV', clientWidth: options.width ?? 1280 };
  const canvas = {
    parentElement: container,
    addEventListener: vi.fn((type: string, listener: EventListener, init?: AddEventListenerOptions) => {
      const set = canvasListeners.get(type) ?? new Set();
      set.add(listener);
      canvasListeners.set(type, set);
      init?.signal?.addEventListener('abort', () => set.delete(listener));
    }),
    removeEventListener: vi.fn(),
    setPointerCapture: vi.fn(),
    hasPointerCapture: vi.fn(() => false),
    releasePointerCapture: vi.fn(),
  } as unknown as HTMLCanvasElement;
  const emit = (type: string, event: Record<string, unknown>) => {
    const full = { type, preventDefault: vi.fn(), ...event } as unknown as Event;
    for (const listener of canvasListeners.get(type) ?? []) listener(full);
  };

  const resizeListeners = new Set<() => void>();
  const output = {
    size: [1280, 720] as [number, number],
    format: 'bgra8unorm',
    onResize: vi.fn((listener: () => void) => {
      resizeListeners.add(listener);
      listener();
      return () => resizeListeners.delete(listener);
    }),
  };
  const stop = vi.fn();
  type Tick = (frame: { pass: ReturnType<typeof vi.fn> }) => void;
  let tick: Tick | undefined;
  const frame = vi.fn((callback: Tick) => callback({ pass: vi.fn() }));
  const gpu = {
    gpu: { queue: { onSubmittedWorkDone: vi.fn(async () => {}) } },
    settled: vi.fn(async () => {}),
    dispose: vi.fn(),
    clock: { time: 0, deltaTime: 1 / 60, frameCount: 0 },
    fns: {
      surface: vi.fn(() => output),
      frame,
      frameLoop: vi.fn((callback: Tick) => {
        tick = callback;
        return { stop };
      }),
    },
  };
  const pipeline = { name: 'pipeline' };
  pipelineMocks.createPipeline.mockResolvedValue(pipeline);
  mocks.init.mockResolvedValueOnce(gpu);
  return {
    canvas,
    container,
    canvasListeners,
    emit,
    motionQuery,
    motionListeners,
    microtasks,
    output,
    resizeListeners,
    pipeline,
    gpu,
    stop,
    frame,
    runFrame: () => tick?.({ pass: vi.fn() }),
    simulation: () => vi.mocked(createSimulation).mock.results.at(-1)!.value as Simulation,
    listenerCount: () => [...canvasListeners.values()].reduce((sum, set) => sum + set.size, 0),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  mocks.init.mockReset();
  pipelineMocks.createPipeline.mockReset();
  guiHarness.instances.length = 0;
});

test('builds the machine on the surface and steps, publishes and draws every frame', async () => {
  const env = setup();
  const renderer = createRenderer({ canvas: env.canvas, container: env.container as unknown as HTMLElement });
  await renderer.ready;

  expect(env.gpu.fns.surface).toHaveBeenCalledWith(env.canvas, { dpr: [1, 2] });
  const [, , size, format] = pipelineMocks.createPipeline.mock.calls[0]!;
  expect(size).toBe(env.output.size);
  // The present pass is compiled for the surface's own format.
  expect(format).toBe(env.output.format);
  expect(createSimulation).toHaveBeenCalledWith({ autoRelease: true, capacity: undefined });
  // The scripted start is on screen before the first frame.
  expect(env.simulation().marbles.length).toBeGreaterThanOrEqual(6);
  expect(env.output.onResize).toHaveBeenCalledOnce();
  expect(pipelineMocks.resizePipeline).toHaveBeenCalledWith(env.pipeline, env.output.size);
  expect(env.listenerCount()).toBe(6);
  expect(guiHarness.instances).toHaveLength(1);
  expect(guiHarness.instances[0]!.options).toMatchObject({ container: env.container, title: 'Marble Machine' });
  expect(guiHarness.instances[0]!.close).not.toHaveBeenCalled();

  const steps = env.simulation().steps;
  env.runFrame();
  // 1/60 s on a 1/120 s fixed step: two steps, give or take accumulator rounding.
  expect(env.simulation().steps).toBeGreaterThan(steps);
  expect(env.simulation().steps).toBeLessThanOrEqual(steps + 2);
  expect(pipelineMocks.publish).toHaveBeenCalledWith(env.pipeline);
  expect(pipelineMocks.setStudio).toHaveBeenCalledOnce();
  expect(pipelineMocks.encode).toHaveBeenCalledWith(expect.anything(), env.pipeline, env.output);
  expect(pipelineMocks.publish.mock.invocationCallOrder[0]).toBeLessThan(pipelineMocks.encode.mock.invocationCallOrder[0]!);

  renderer.dispose();
});

test('keyboard and panel drive the same pause state, and steps only advance while paused', async () => {
  const env = setup();
  const renderer = createRenderer({ canvas: env.canvas });
  await renderer.ready;
  const gui = guiHarness.instances[0]!;
  const paused = gui.control('Paused');

  env.emit('keydown', { key: ' ' });
  expect(env.simulation().paused).toBe(true);
  expect(paused.model.paused).toBe(true);
  expect(paused.updateDisplay).toHaveBeenCalledOnce();
  const steps = env.simulation().steps;
  env.runFrame();
  expect(env.simulation().steps).toBe(steps);
  env.emit('keydown', { key: '.' });
  expect(env.simulation().steps).toBe(steps + 2);

  paused.model.paused = false;
  paused.change!(false);
  expect(env.simulation().paused).toBe(false);
  env.emit('keydown', { key: '.' });
  expect(env.simulation().steps).toBe(steps + 2);

  // A release either drops now or waits for the hopper to clear.
  const released = () => env.simulation().marbles.length + env.simulation().pendingReleases;
  const before = released();
  env.emit('keydown', { key: 'Enter' });
  expect(released()).toBe(before + 1);
  gui.control('Gravity ×').change!(1.5);
  gui.control('Bounce').change!(0.1);
  expect(env.simulation().world.gravity.y).toBeCloseTo(-98.1 * 1.5, 4);
  env.emit('keydown', { key: 'r' });
  expect(env.simulation().world.gravity.y).toBeCloseTo(-98.1 * 1.5, 4);
  renderer.dispose();
});

test('touch devices run fewer marbles and narrow frames start with the panel closed', async () => {
  const env = setup({ coarsePointer: true, width: 390 });
  const renderer = createRenderer({ canvas: env.canvas });
  await renderer.ready;
  expect(createSimulation).toHaveBeenCalledWith({ autoRelease: true, capacity: 24 });
  expect(guiHarness.instances[0]!.close).toHaveBeenCalledOnce();
  renderer.dispose();
});

test('reduced motion stops automatic releases and the travelling camera, and follows changes', async () => {
  const env = setup({ reducedMotion: true });
  const renderer = createRenderer({ canvas: env.canvas });
  await renderer.ready;
  expect(createSimulation).toHaveBeenCalledWith({ autoRelease: false, capacity: undefined });
  // Still a populated machine, not an empty one.
  expect(env.simulation().marbles.length).toBeGreaterThanOrEqual(6);
  const gui = guiHarness.instances[0]!;
  const camera = gui.control('Camera');
  camera.model.camera = 'follow';
  camera.change!('follow');

  for (const listener of env.motionListeners) listener({ matches: false } as MediaQueryListEvent);
  expect(env.simulation().autoRelease).toBe(true);
  expect(camera.model.camera).toBe('follow');
  for (const listener of env.motionListeners) listener({ matches: true } as MediaQueryListEvent);
  expect(env.simulation().autoRelease).toBe(false);
  expect(camera.model.camera).toBe('machine');
  expect(camera.updateDisplay).toHaveBeenCalledTimes(2);

  // Once the user sets Auto release by hand, preference changes no longer flip it.
  const autoRelease = gui.control('Auto release');
  autoRelease.model.autoRelease = true;
  autoRelease.change!(true);
  for (const listener of env.motionListeners) listener({ matches: true } as MediaQueryListEvent);
  expect(env.simulation().autoRelease).toBe(true);
  expect(autoRelease.model.autoRelease).toBe(true);
  autoRelease.model.autoRelease = false;
  autoRelease.change!(false);
  for (const listener of env.motionListeners) listener({ matches: false } as MediaQueryListEvent);
  expect(env.simulation().autoRelease).toBe(false);
  expect(autoRelease.model.autoRelease).toBe(false);
  renderer.dispose();
  expect(env.motionListeners.size).toBe(0);
});

test('dispose is idempotent and releases the loop, listeners, panel and GPU', async () => {
  const env = setup();
  const renderer = createRenderer({ canvas: env.canvas });
  await renderer.ready;
  renderer.dispose();
  renderer.dispose();
  expect(env.stop).toHaveBeenCalledOnce();
  expect(env.resizeListeners.size).toBe(0);
  expect(env.motionListeners.size).toBe(0);
  expect(env.listenerCount()).toBe(0);
  expect(guiHarness.instances[0]!.destroy).toHaveBeenCalledOnce();
  expect(env.gpu.dispose).toHaveBeenCalledOnce();
  // Events that were already queued do nothing after dispose.
  env.runFrame();
  expect(pipelineMocks.encode).not.toHaveBeenCalled();
});

test('a GPU that arrives after dispose is released without creating a surface', async () => {
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

test('dispose while the pipeline compiles stops before any listener or panel exists', async () => {
  const env = setup();
  const compile = deferred<typeof env.pipeline>();
  pipelineMocks.createPipeline.mockReset().mockReturnValueOnce(compile.promise);
  const renderer = createRenderer({ canvas: env.canvas });
  await vi.waitFor(() => expect(pipelineMocks.createPipeline).toHaveBeenCalledOnce());
  renderer.dispose();
  compile.resolve(env.pipeline);
  await renderer.ready;
  expect(env.gpu.dispose).toHaveBeenCalledOnce();
  expect(env.listenerCount()).toBe(0);
  expect(guiHarness.instances).toHaveLength(0);
  expect(env.gpu.fns.frameLoop).not.toHaveBeenCalled();
});

test('initialization failures reject ready and dispose the GPU', async () => {
  const env = setup();
  pipelineMocks.createPipeline.mockReset().mockRejectedValueOnce(new Error('compile failed'));
  const renderer = createRenderer({ canvas: env.canvas });
  await expect(renderer.ready).rejects.toThrow('compile failed');
  expect(env.gpu.dispose).toHaveBeenCalledOnce();
  expect(env.listenerCount()).toBe(0);

  vi.unstubAllGlobals();
  setup();
  mocks.init.mockReset().mockRejectedValueOnce(new Error('no adapter'));
  await expect(createRenderer({ canvas: env.canvas }).ready).rejects.toThrow('no adapter');
});

test('a throwing frame disposes once and surfaces the error once', async () => {
  const env = setup();
  const renderer = createRenderer({ canvas: env.canvas });
  await renderer.ready;
  pipelineMocks.encode.mockImplementationOnce(() => {
    throw new Error('encode failed');
  });
  env.runFrame();
  env.runFrame();
  env.emit('keydown', { key: 'Enter' });
  expect(env.gpu.dispose).toHaveBeenCalledOnce();
  expect(env.stop).toHaveBeenCalledOnce();
  expect(env.microtasks).toHaveLength(1);
  expect(() => env.microtasks[0]!()).toThrow('encode failed');
  renderer.dispose();
  expect(env.gpu.dispose).toHaveBeenCalledOnce();
});

test('the thumbnail renders real physics through the shared pipeline and waits for both drains', async () => {
  const env = setup();
  const drained = deferred<void>();
  const settled = deferred<void>();
  env.gpu.gpu.queue.onSubmittedWorkDone.mockReturnValueOnce(drained.promise);
  env.gpu.settled.mockReturnValueOnce(settled.promise);
  const output = { size: [320, 180] as const, format: 'rgba8unorm' };
  let finished = false;
  const done = renderThumbnail(env.gpu as never, output as never, { warmupFrames: 3, dt: 1 / 60, time: 1 }).then(() => {
    finished = true;
  });
  await vi.waitFor(() => expect(env.gpu.settled).toHaveBeenCalledOnce());
  expect(env.gpu.gpu.queue.onSubmittedWorkDone).toHaveBeenCalledOnce();
  expect(env.frame).toHaveBeenCalledTimes(3);
  expect(pipelineMocks.encode).toHaveBeenCalledTimes(3);
  expect(pipelineMocks.encode).toHaveBeenLastCalledWith(expect.anything(), env.pipeline, output);
  expect(pipelineMocks.createPipeline.mock.calls[0]![3]).toBe('rgba8unorm');
  // 900 scripted steps plus one simulated second of 1/120 s steps.
  expect(Math.abs(env.simulation().steps - (900 + 120))).toBeLessThanOrEqual(1);
  drained.resolve();
  await Promise.resolve();
  expect(finished).toBe(false);
  settled.resolve();
  await done;
  expect(env.gpu.dispose).not.toHaveBeenCalled();
});

test.each([1 / 30, 1 / 60, 1 / 144])('the thumbnail simulates the requested time at dt %f', async (dt) => {
  const env = setup();
  await renderThumbnail(env.gpu as never, { size: [64, 36], format: 'rgba8unorm' } as never, { dt, time: 2 });
  expect(Math.abs(env.simulation().steps - (900 + 240))).toBeLessThanOrEqual(1);
});

test('a thumbnail that fails to build still drains the GPU before rethrowing', async () => {
  const env = setup();
  pipelineMocks.createPipeline.mockReset().mockRejectedValueOnce(new Error('compile failed'));
  const settled = deferred<void>();
  env.gpu.settled.mockReturnValueOnce(settled.promise);
  let outcome: unknown;
  const done = renderThumbnail(env.gpu as never, { size: [64, 36], format: 'rgba8unorm' } as never).catch((error) => {
    outcome = error;
  });
  await vi.waitFor(() => expect(env.gpu.settled).toHaveBeenCalledOnce());
  expect(outcome).toBeUndefined();
  settled.resolve();
  await done;
  expect(outcome).toBeInstanceOf(Error);
  expect((outcome as Error).message).toBe('compile failed');
  expect(env.gpu.gpu.queue.onSubmittedWorkDone).toHaveBeenCalledOnce();
  expect(env.frame).not.toHaveBeenCalled();
  expect(env.gpu.dispose).not.toHaveBeenCalled();
});
