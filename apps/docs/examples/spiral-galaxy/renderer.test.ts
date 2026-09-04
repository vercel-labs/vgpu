import { afterEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ init: vi.fn() }));
const guiHarness = vi.hoisted(() => {
  interface Control {
    model: Record<string, unknown>;
    property: string;
    label?: string;
    change?: (value: unknown) => unknown;
    name(label: string): Control;
    onChange(change: (value: unknown) => unknown): Control;
  }
  class FakeGui {
    options: unknown;
    domElement = { style: {} as Record<string, string> };
    destroy = vi.fn();
    controls: Control[] = [];

    constructor(options: unknown) {
      this.options = options;
      instances.push(this);
    }

    add(model: Record<string, unknown>, property: string): Control {
      const control: Control = {
        model,
        property,
        name(label) {
          control.label = label;
          return control;
        },
        onChange(change) {
          control.change = change;
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
      [
        'surface',
        'target',
        'effect',
        'draw',
        'compute',
        'storage',
        'sampler',
        'frame',
        'frameLoop',
      ].map((name) => [
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

import { generateField } from './field';
import { renderThumbnail } from './render-thumbnail';
import { createRenderer } from './renderer';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function setup(options: { failCompile?: boolean; reducedMotion?: boolean } = {}) {
  const windowListeners = new Map<string, EventListener>();
  const canvasListeners = new Map<string, EventListener>();
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  vi.stubGlobal('window', {
    devicePixelRatio: 2,
    matchMedia: vi.fn(() => ({ matches: options.reducedMotion ?? false })),
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
  const container = { tagName: 'DIV' };
  const canvas = {
    parentElement: container,
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
    size: readonly [number, number];
    texelSize: readonly [number, number];
    destroy: ReturnType<typeof vi.fn>;
    format: string;
    read: ReturnType<typeof vi.fn>;
  }> = [];
  const storageObjects: Array<{ size: number; write: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> }> = [];
  const effects: Array<{ set: ReturnType<typeof vi.fn>; compile: ReturnType<typeof vi.fn> }> = [];
  const computes: Array<{ set: ReturnType<typeof vi.fn>; dispatch: ReturnType<typeof vi.fn> }> = [];
  const surface = { size: [200, 100] as const, format: 'bgra8unorm', dispose: vi.fn() };
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
  const frame = vi.fn((callback: (frame: { pass: ReturnType<typeof vi.fn> }) => void) => {
    callback({ pass: vi.fn() });
  });
  const gpu = {
    gpu: { queue: { onSubmittedWorkDone: vi.fn(async () => {}) } },
    settled: vi.fn(async () => {}),
    dispose: vi.fn(),
    fns: {
      surface: vi.fn(() => surface),
      target: vi.fn((opts: { size: readonly [number, number]; format?: string }) => {
        const target = {
          size: opts.size,
          texelSize: [1 / opts.size[0], 1 / opts.size[1]] as const,
          destroy: vi.fn(),
          format: opts.format ?? 'rgba8unorm',
          read: vi.fn(async () => new Uint8Array()),
        };
        targetObjects.push(target);
        return target;
      }),
      storage: vi.fn((bytes: number) => {
        const buffer = { size: bytes, write: vi.fn(), destroy: vi.fn() };
        storageObjects.push(buffer);
        return buffer;
      }),
      effect: vi.fn(effect),
      draw: vi.fn(effect),
      compute: vi.fn(() => {
        const value = { set: vi.fn(), dispatch: vi.fn() };
        computes.push(value);
        return value;
      }),
      sampler: vi.fn(() => ({})),
      frame,
      frameLoop: vi.fn((callback: NonNullable<typeof liveFrame>) => {
        liveFrame = callback;
        return { stop };
      }),
    },
  };
  mocks.init.mockResolvedValueOnce(gpu);
  return {
    canvas,
    container,
    canvasListeners,
    windowListeners,
    frames,
    disconnect,
    effects,
    computes,
    targetObjects,
    storageObjects,
    surface,
    gpu,
    stop,
    frame,
    runFrame: () => {
      const pass = vi.fn();
      liveFrame?.({ pass });
      return pass;
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  guiHarness.instances.length = 0;
});

test('initializes the field, bakes the dirt map and drives the simulation every frame', async () => {
  const env = setup();
  const renderer = createRenderer({ canvas: env.canvas });
  await renderer.ready;
  const field = generateField();

  expect(mocks.init).toHaveBeenCalledWith({ requiredLimits: { maxStorageBuffersInVertexStage: 1 } });
  expect(env.gpu.fns.frameLoop).toHaveBeenCalledOnce();
  // Six storage buffers: stars, paths, layers, motion, projected, flares.
  expect(env.storageObjects).toHaveLength(6);
  expect(env.storageObjects[0]!.size).toBe(field.stars.byteLength);
  expect(env.storageObjects[0]!.write).toHaveBeenCalledWith(field.stars);
  expect(env.storageObjects[3]!.write).toHaveBeenCalledOnce();
  // One dirt target plus five chain targets.
  expect(env.gpu.fns.target).toHaveBeenCalledTimes(6);
  expect(env.frame).toHaveBeenCalledOnce();
  expect(env.canvasListeners.has('pointermove')).toBe(true);
  expect(env.canvasListeners.has('keydown')).toBe(true);
  expect(env.canvas.style.touchAction).toBe('none');
  // The controls are a lil-gui panel mounted in the example container.
  expect(guiHarness.instances).toHaveLength(1);
  const gui = guiHarness.instances[0]!;
  expect(gui.options).toMatchObject({ container: env.container, title: 'Spiral Galaxy' });
  expect(gui.domElement.style.position).toBe('absolute');
  expect(gui.controls.map((control) => control.label)).toEqual([
    'Replay intro',
    'Lens flare',
    'Dirty glass',
    'Hover repel',
  ]);

  const pass = env.runFrame();
  const simulate = env.computes[0]!;
  expect(simulate.dispatch).toHaveBeenCalledWith(Math.ceil(field.count / 64));
  const params = simulate.set.mock.calls.at(-1)?.[0].params;
  expect(params.intro).toBeCloseTo((1 / 60) / 5.5, 6);
  expect(params.repelEnabled).toBe(0);
  expect(env.storageObjects[2]!.write).toHaveBeenCalled();
  // stars → bright → 4 blurs → composite.
  expect(pass).toHaveBeenCalledTimes(7);

  // Hovering feeds an impulse into the simulation on the next frame.
  env.canvasListeners.get('pointermove')?.({ isPrimary: true, pointerType: 'mouse', pointerId: 1, buttons: 0, clientX: 50, clientY: 50 } as unknown as Event);
  env.runFrame();
  env.canvasListeners.get('pointermove')?.({ isPrimary: true, pointerType: 'mouse', pointerId: 1, buttons: 0, clientX: 70, clientY: 40 } as unknown as Event);
  env.runFrame();
  const moved = simulate.set.mock.calls.at(-1)?.[0].params;
  expect(moved.repelImpulse).toBe(1);
  expect(moved.impulse[0]).toBeCloseTo(0.2, 6);
  expect(moved.impulse[1]).toBeCloseTo(0.2, 6);

  const replay = gui.control('Replay intro');
  (replay.model[replay.property] as () => void)();
  env.runFrame();
  // Replay clears the motion buffer and restarts the intro.
  expect(env.storageObjects[3]!.write).toHaveBeenCalledTimes(2);
  expect(simulate.set.mock.calls.at(-1)?.[0].params.intro).toBeCloseTo((1 / 60) / 5.5, 6);

  // Toggles reach the composite uniforms and the repel input.
  const composite = env.effects.at(-1)!;
  const flare = gui.control('Lens flare');
  flare.model[flare.property] = false;
  flare.change?.(false);
  expect(composite.set.mock.calls.at(-1)?.[0].params).toEqual({ flareEnabled: 0, dirtEnabled: 1 });
  const repel = gui.control('Hover repel');
  repel.model[repel.property] = false;
  repel.change?.(false);
  env.canvasListeners.get('pointermove')?.({ isPrimary: true, pointerType: 'mouse', pointerId: 1, buttons: 0, clientX: 20, clientY: 20 } as unknown as Event);
  env.runFrame();
  env.canvasListeners.get('pointermove')?.({ isPrimary: true, pointerType: 'mouse', pointerId: 1, buttons: 0, clientX: 60, clientY: 40 } as unknown as Event);
  env.runFrame();
  expect(simulate.set.mock.calls.at(-1)?.[0].params.repelImpulse).toBe(0);

  renderer.dispose();
  expect(gui.destroy).toHaveBeenCalledOnce();
});

test('coalesces resize work, rebinds the chain and delegates teardown to the GPU', async () => {
  const env = setup();
  const renderer = createRenderer({ canvas: env.canvas });
  await renderer.ready;

  renderer.resize({ width: 300, height: 150, dpr: 1.6 });
  renderer.resize({ width: 400, height: 200, dpr: 1.6 });
  expect(env.frames.size).toBe(1);
  [...env.frames.values()][0]?.(16);
  expect(env.gpu.fns.target).toHaveBeenCalledTimes(11);
  expect(env.targetObjects[6]!.size).toEqual([640, 320]);
  for (const target of env.targetObjects.slice(1, 6)) expect(target.destroy).toHaveBeenCalledOnce();
  expect(env.targetObjects[0]!.destroy).not.toHaveBeenCalled();
  for (const target of env.targetObjects.slice(6)) expect(target.destroy).not.toHaveBeenCalled();
  const view = env.effects[0]!.set.mock.calls.at(-1)?.[0].view;
  expect(view.resolution).toEqual([640, 320]);
  // The resize invalidated screen-space repel state.
  env.runFrame();
  expect(env.storageObjects[3]!.write).toHaveBeenCalledTimes(2);

  renderer.dispose();
  renderer.dispose();
  expect(env.stop).not.toHaveBeenCalled();
  expect(env.disconnect).toHaveBeenCalledOnce();
  expect(env.canvas.style.touchAction).toBe('pan-y');
  expect(env.canvasListeners.size).toBe(0);
  expect(env.windowListeners.size).toBe(0);
  expect(env.surface.dispose).not.toHaveBeenCalled();
  expect(env.gpu.dispose).toHaveBeenCalledOnce();
  expect(guiHarness.instances[0]!.destroy).toHaveBeenCalledOnce();
});

test('reduced motion skips the intro', async () => {
  const env = setup({ reducedMotion: true });
  const renderer = createRenderer({ canvas: env.canvas });
  await renderer.ready;
  env.runFrame();
  expect(env.computes[0]!.set.mock.calls.at(-1)?.[0].params.intro).toBe(1);
  renderer.dispose();
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
  expect(env.canvasListeners.size).toBe(0);
  expect(guiHarness.instances).toHaveLength(0);
});

test('a missing GUI container fails initialization and tears down', async () => {
  const env = setup();
  (env.canvas as unknown as { parentElement: unknown }).parentElement = null;
  const renderer = createRenderer({ canvas: env.canvas });
  await expect(renderer.ready).rejects.toThrow('needs a GUI container');
  expect(env.gpu.dispose).toHaveBeenCalledOnce();
  expect(env.canvasListeners.size).toBe(0);
});

test('thumbnail renders deterministic frames and destroys its resources', async () => {
  const env = setup();
  const output = { size: [160, 90] as const, format: 'rgba8unorm', read: vi.fn(async () => new Uint8Array()) };
  await renderThumbnail(env.gpu as never, output as never, { warmupFrames: 3, time: 7 });
  // One dirt bake plus three warmup frames.
  expect(env.frame).toHaveBeenCalledTimes(4);
  expect(env.computes[0]!.dispatch).toHaveBeenCalledTimes(3);
  expect(env.computes[0]!.set.mock.calls.at(-1)?.[0].params.intro).toBe(1);
  for (const target of env.targetObjects) expect(target.destroy).toHaveBeenCalledOnce();
  for (const buffer of env.storageObjects) expect(buffer.destroy).toHaveBeenCalledOnce();
});

test('thumbnail destroys its resources when prewarm fails', async () => {
  const env = setup({ failCompile: true });
  const output = { size: [160, 90] as const, format: 'rgba8unorm', read: vi.fn(async () => new Uint8Array()) };
  await expect(renderThumbnail(env.gpu as never, output as never)).rejects.toThrow('compile failed');
  expect(env.targetObjects).toHaveLength(6);
  for (const target of env.targetObjects) expect(target.destroy).toHaveBeenCalledOnce();
  for (const buffer of env.storageObjects) expect(buffer.destroy).toHaveBeenCalledOnce();
});
