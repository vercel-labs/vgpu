import { afterEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  init: vi.fn(),
  bridges: [] as { collection: { count: number }; publish: ReturnType<typeof vi.fn> }[],
}));
const guiHarness = vi.hoisted(() => {
  interface Control {
    object: Record<string, unknown>;
    property: string;
    label: string;
    finish?: (value: unknown) => void;
    updateDisplay: ReturnType<typeof vi.fn>;
    name(label: string): Control;
    onFinishChange(callback: (value: unknown) => void): Control;
  }
  class FakeGui {
    readonly domElement = { style: {} as Record<string, string> };
    readonly controls: Control[] = [];
    readonly close = vi.fn();
    readonly destroy = vi.fn();
    constructor(readonly options: Record<string, unknown>) {
      instances.push(this);
    }
    add(object: Record<string, unknown>, property: string): Control {
      const control: Control = {
        object,
        property,
        label: property,
        updateDisplay: vi.fn(),
        name(label) {
          control.label = label;
          return control;
        },
        onFinishChange(callback) {
          control.finish = callback;
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
      ['surface', 'target', 'effect', 'draw', 'geometry', 'sampler', 'frame', 'frameLoop'].map((name) => [
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
vi.mock('vgpu/scene/gpu', () => ({
  instanceGeometry: vi.fn((_gpu: unknown, collection: { count: number }) => {
    const bridge = { collection, geometry: {}, publish: vi.fn(() => collection.count) };
    mocks.bridges.push(bridge);
    return bridge;
  }),
}));
// The real scene, with poseMobile observed so tests can read the animation time per frame.
vi.mock('./scene', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./scene')>();
  return { ...actual, poseMobile: vi.fn(actual.poseMobile) };
});

import { renderThumbnail } from './render-thumbnail';
import { createRenderer } from './renderer';
import { countShapes, MESHES, poseMobile } from './scene';

/** The animation time of the latest pose the renderer wrote. */
const poseTime = () => vi.mocked(poseMobile).mock.lastCall![1].time;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function browser(options: { reducedMotion?: boolean; width?: number } = {}) {
  const canvasListeners = new Map<string, EventListener>();
  const motionListeners = new Set<(event: { matches: boolean }) => void>();
  const microtasks: (() => void)[] = [];
  const motionQuery = {
    matches: options.reducedMotion ?? false,
    addEventListener: vi.fn((_name: string, listener: (event: { matches: boolean }) => void) => motionListeners.add(listener)),
    removeEventListener: vi.fn((_name: string, listener: (event: { matches: boolean }) => void) => motionListeners.delete(listener)),
  };
  vi.stubGlobal('window', { devicePixelRatio: 2, matchMedia: vi.fn(() => motionQuery) });
  vi.stubGlobal('queueMicrotask', (task: () => void) => microtasks.push(task));
  const canvas = {
    addEventListener: vi.fn((name: string, listener: EventListener, init?: AddEventListenerOptions) => {
      canvasListeners.set(name, listener);
      init?.signal?.addEventListener('abort', () => canvasListeners.delete(name));
    }),
    setPointerCapture: vi.fn(),
    hasPointerCapture: vi.fn(() => false),
    releasePointerCapture: vi.fn(),
  } as unknown as HTMLCanvasElement;
  const container = { clientWidth: options.width ?? 1280 } as HTMLElement;
  return { canvas, container, canvasListeners, motionListeners, motionQuery, microtasks };
}

function gpuDouble(options: { failCompile?: Error } = {}) {
  const stop = vi.fn();
  const unsubscribeResize = vi.fn();
  const resizeListeners: (() => void)[] = [];
  const surface = {
    size: [1280, 720] as [number, number],
    format: 'rgba8unorm',
    onResize: vi.fn((listener: () => void) => {
      resizeListeners.push(listener);
      listener();
      return unsubscribeResize;
    }),
  };
  const targets: { size: [number, number]; resize: ReturnType<typeof vi.fn> }[] = [];
  const passable = () => ({
    set: vi.fn(),
    compile: vi.fn(() => (options.failCompile ? Promise.reject(options.failCompile) : Promise.resolve())),
  });
  const passes: { target: unknown; draws: unknown[] }[] = [];
  const currentFrame = {
    pass: vi.fn((descriptor: { target?: unknown }, body: (pass: { draw: (draw: unknown) => void }) => void) => {
      const record = { target: descriptor.target ?? descriptor, draws: [] as unknown[] };
      passes.push(record);
      body({ draw: (draw) => record.draws.push(draw) });
    }),
  };
  let tick: ((frame: typeof currentFrame) => void) | undefined;
  const instance = {
    gpu: { queue: { onSubmittedWorkDone: vi.fn(() => Promise.resolve()) } },
    settled: vi.fn(() => Promise.resolve()),
    clock: { time: 0, deltaTime: 1 / 60, frameCount: 0 },
    fns: {
      surface: vi.fn(() => surface),
      target: vi.fn((descriptor: { size: [number, number] }) => {
        const created = {
          size: descriptor.size,
          resize: vi.fn((size: [number, number]) => {
            created.size = size;
          }),
        };
        targets.push(created);
        return created;
      }),
      geometry: vi.fn(() => ({})),
      sampler: vi.fn(() => ({})),
      draw: vi.fn(passable),
      effect: vi.fn(passable),
      frame: vi.fn((_callback: unknown) => {}),
      frameLoop: vi.fn((callback: (frame: typeof currentFrame) => void) => {
        tick = callback;
        return { stop };
      }),
    },
    dispose: vi.fn(),
  };
  const runFrame = () => {
    passes.length = 0;
    tick?.(currentFrame);
    return passes;
  };
  return { instance, surface, targets, stop, unsubscribeResize, resizeListeners, currentFrame, runFrame };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  guiHarness.instances.length = 0;
  mocks.bridges.length = 0;
});

test('a GPU that arrives after dispose is released without building anything', async () => {
  const { canvas, container } = browser();
  const pending = deferred<ReturnType<typeof gpuDouble>['instance']>();
  mocks.init.mockReturnValueOnce(pending.promise);
  const renderer = createRenderer({ canvas, container });
  await vi.waitFor(() => expect(mocks.init).toHaveBeenCalledOnce());
  renderer.dispose();
  const late = gpuDouble();
  pending.resolve(late.instance);
  await renderer.ready;
  expect(late.instance.dispose).toHaveBeenCalledOnce();
  expect(late.instance.fns.surface).not.toHaveBeenCalled();
  expect(guiHarness.instances).toHaveLength(0);
});

test('an initialization failure rejects ready and disposes', async () => {
  const { canvas, container, canvasListeners } = browser();
  const error = new Error('pipeline failed');
  const failing = gpuDouble({ failCompile: error });
  mocks.init.mockResolvedValueOnce(failing.instance);
  const renderer = createRenderer({ canvas, container });
  await expect(renderer.ready).rejects.toBe(error);
  expect(failing.instance.dispose).toHaveBeenCalledOnce();
  expect(failing.instance.fns.frameLoop).not.toHaveBeenCalled();
  expect(canvasListeners.size).toBe(0);
  renderer.dispose();
  expect(failing.instance.dispose).toHaveBeenCalledOnce();
});

test('renders shadow → scene → present each frame and resizes the scene target', async () => {
  const { canvas, container } = browser();
  const live = gpuDouble();
  mocks.init.mockResolvedValueOnce(live.instance);
  const renderer = createRenderer({ canvas, container });
  await renderer.ready;
  expect(live.instance.fns.surface).toHaveBeenCalledWith(canvas, { dpr: [1, 2] });
  expect(live.instance.fns.frameLoop).toHaveBeenCalledOnce();

  const passes = live.runFrame();
  expect(passes.map((pass) => pass.target)).toEqual([live.targets[0], live.targets[1], live.surface]);
  // Four casters, then the backdrop plus four lit draws, then the present effect.
  expect(passes.map((pass) => pass.draws.length)).toEqual([4, 5, 1]);

  live.surface.size = [832, 468];
  live.resizeListeners[0]!();
  expect(live.targets[1]!.resize).toHaveBeenCalledWith([832, 468]);
  renderer.dispose();
});

test('dispose is idempotent and releases the loop, listeners, panel and GPU', async () => {
  const { canvas, container, canvasListeners, motionListeners } = browser();
  const live = gpuDouble();
  mocks.init.mockResolvedValueOnce(live.instance);
  const renderer = createRenderer({ canvas, container });
  await renderer.ready;
  expect([...canvasListeners.keys()].sort()).toEqual(['keydown', 'pointercancel', 'pointerdown', 'pointermove', 'pointerup', 'wheel']);
  expect(motionListeners.size).toBe(1);

  renderer.dispose();
  renderer.dispose();
  expect(live.stop).toHaveBeenCalledOnce();
  expect(live.unsubscribeResize).toHaveBeenCalledOnce();
  expect(guiHarness.instances[0]!.destroy).toHaveBeenCalledOnce();
  expect(live.instance.dispose).toHaveBeenCalledOnce();
  expect(canvasListeners.size).toBe(0);
  expect(motionListeners.size).toBe(0);
  // A stale frame after dispose does nothing.
  expect(live.runFrame()).toHaveLength(0);
});

test('a throwing frame disposes once and surfaces the error a single time', async () => {
  const { canvas, container, microtasks } = browser();
  const live = gpuDouble();
  mocks.init.mockResolvedValueOnce(live.instance);
  const renderer = createRenderer({ canvas, container });
  await renderer.ready;
  const error = new Error('frame failed');
  live.currentFrame.pass.mockImplementation(() => {
    throw error;
  });
  live.runFrame();
  live.runFrame();
  expect(live.instance.dispose).toHaveBeenCalledOnce();
  expect(microtasks).toHaveLength(1);
  expect(() => microtasks[0]!()).toThrow(error);
  renderer.dispose();
});

test('the panel rebuilds levels inside capacity, resets, and starts closed in narrow frames', async () => {
  const { canvas, container } = browser({ width: 832 });
  const live = gpuDouble();
  mocks.init.mockResolvedValueOnce(live.instance);
  const renderer = createRenderer({ canvas, container });
  await renderer.ready;
  const gui = guiHarness.instances[0]!;
  expect(gui.options).toMatchObject({ container, title: 'Kinetic Sculpture' });
  expect(gui.domElement.style.position).toBe('absolute');
  expect(gui.close).toHaveBeenCalledOnce();
  expect(gui.controls.map((control) => control.label)).toEqual(['Speed', 'Swing', 'Levels', 'Root angle', 'Pause', 'Reset']);

  const collectionCounts = () => mocks.bridges.map((bridge) => bridge.collection.count);
  for (const levels of [5, 2, 3, 5]) {
    gui.control('Levels').finish?.(levels);
    expect(collectionCounts()).toEqual(MESHES.map((mesh) => countShapes(levels)[mesh]));
    expect(live.runFrame()).toHaveLength(3);
  }
  expect(live.instance.dispose).not.toHaveBeenCalled();

  // Pause renames the button and freezes the animation time, while manual edits still render.
  live.instance.clock.deltaTime = 0.05;
  live.runFrame();
  const before = poseTime();
  const pause = gui.control('Pause');
  (pause.object[pause.property] as () => void)();
  expect(pause.label).toBe('Resume');
  live.runFrame();
  live.runFrame();
  expect(poseTime()).toBe(before);
  const settings = gui.control('Root angle').object;
  settings.rootAngle = 90;
  expect(live.runFrame()).toHaveLength(3);
  expect(vi.mocked(poseMobile).mock.lastCall![1]).toMatchObject({ time: before, rootAngle: Math.PI / 2 });

  // Reset returns to the start and re-reads the panel; the mobile stays paused.
  const reset = gui.control('Reset');
  (reset.object[reset.property] as () => void)();
  expect(settings.rootAngle).toBe(0);
  expect(gui.control('Root angle').updateDisplay).toHaveBeenCalled();
  live.runFrame();
  expect(poseTime()).toBe(0);
  expect(pause.label).toBe('Resume');

  // Resume advances by the frame time scaled by Speed.
  (pause.object[pause.property] as () => void)();
  expect(pause.label).toBe('Pause');
  live.runFrame();
  expect(poseTime()).toBeCloseTo(0.05 * (settings.speed as number));
  renderer.dispose();
});

test('the panel starts open on wide frames', async () => {
  const { canvas, container } = browser({ width: 1280 });
  const live = gpuDouble();
  mocks.init.mockResolvedValueOnce(live.instance);
  const renderer = createRenderer({ canvas, container });
  await renderer.ready;
  expect(guiHarness.instances[0]!.close).not.toHaveBeenCalled();
  renderer.dispose();
});

test('reduced motion starts calmer and follows the preference change', async () => {
  const { canvas, container, motionListeners } = browser({ reducedMotion: true });
  const live = gpuDouble();
  mocks.init.mockResolvedValueOnce(live.instance);
  const renderer = createRenderer({ canvas, container });
  await renderer.ready;
  const settings = guiHarness.instances[0]!.control('Speed').object;
  expect(settings).toMatchObject({ speed: 0.4, swing: 0.5, playing: true });
  for (const listener of motionListeners) listener({ matches: false });
  expect(settings).toMatchObject({ speed: 1, swing: 1 });
  expect(guiHarness.instances[0]!.control('Speed').updateDisplay).toHaveBeenCalled();
  // A value the user picked survives the next change; the untouched one follows the preset.
  settings.speed = 1.6;
  for (const listener of motionListeners) listener({ matches: true });
  expect(settings).toMatchObject({ speed: 1.6, swing: 0.5 });
  renderer.dispose();
});

test('the thumbnail drains and settles submitted work even when rendering throws', async () => {
  const error = new Error('render failed');
  const drainPending = deferred<void>();
  const settledPending = deferred<void>();
  const thumbnail = gpuDouble();
  thumbnail.instance.gpu.queue.onSubmittedWorkDone.mockImplementation(() => drainPending.promise);
  thumbnail.instance.settled.mockImplementation(() => settledPending.promise);
  thumbnail.instance.fns.frame.mockImplementation(() => {
    throw error;
  });
  const output = { size: [160, 90], format: 'rgba8unorm' };
  const rendering = renderThumbnail(thumbnail.instance as never, output as never, { time: 6.5 });
  let completed = false;
  void rendering.then(
    () => (completed = true),
    () => (completed = true),
  );
  await vi.waitFor(() => {
    expect(thumbnail.instance.gpu.queue.onSubmittedWorkDone).toHaveBeenCalledOnce();
    expect(thumbnail.instance.settled).toHaveBeenCalledOnce();
  });
  expect(completed).toBe(false);
  drainPending.resolve();
  settledPending.resolve();
  await expect(rendering).rejects.toBe(error);
  expect(thumbnail.instance.dispose).not.toHaveBeenCalled();
});

test('the thumbnail renders the three passes into the given target', async () => {
  const thumbnail = gpuDouble();
  let passes: ReturnType<typeof thumbnail.runFrame> = [];
  thumbnail.instance.fns.frame.mockImplementation((callback: unknown) => {
    passes = [];
    const record = (descriptor: { target?: unknown }, body: (pass: { draw: (draw: unknown) => void }) => void) => {
      const entry = { target: descriptor.target, draws: [] as unknown[] };
      passes.push(entry);
      body({ draw: (draw) => entry.draws.push(draw) });
    };
    (callback as (frame: unknown) => void)({ pass: record });
  });
  const output = { size: [1280, 720], format: 'rgba8unorm' };
  await renderThumbnail(thumbnail.instance as never, output as never);
  expect(passes.map((pass) => pass.target)).toEqual([thumbnail.targets[0], thumbnail.targets[1], output]);
  expect(passes.map((pass) => pass.draws.length)).toEqual([4, 5, 1]);
});
