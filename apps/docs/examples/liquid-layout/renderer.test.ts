import { afterEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ init: vi.fn() }));
const motion = vi.hoisted(() => ({
  postRender: vi.fn(),
  cancelFrame: vi.fn(),
  frameData: { delta: 1000 / 60 },
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
  }
  class FakeGui {
    options: unknown;
    domElement = { style: {} as Record<string, string> };
    destroy = vi.fn();
    close = vi.fn();
    controllers: Control[] = [];
    folders: FakeGui[] = [];
    // Every control in the tree, for lookups by label.
    all: Control[];

    constructor(options: unknown, root?: FakeGui) {
      this.options = options;
      this.all = root?.all ?? [];
      if (!root) instances.push(this);
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
      };
      this.controllers.push(control);
      this.all.push(control);
      return control;
    }

    addFolder(title: string): FakeGui {
      const folder = new FakeGui({ title }, this);
      this.folders.push(folder);
      return folder;
    }

    control(label: string): Control {
      const found = this.all.find((candidate) => candidate.label === label);
      if (!found) throw new Error(`No GUI control labelled ${label}`);
      return found;
    }

    set(label: string, value: unknown) {
      const control = this.control(label);
      control.model[control.property] = value;
      control.change?.(value);
    }

    press(label: string) {
      const control = this.control(label);
      (control.model[control.property] as () => void)();
    }
  }
  const instances: FakeGui[] = [];
  return { FakeGui, instances };
});
const vgpuFns = vi.hoisted(
  () =>
    Object.fromEntries(
      ['surface', 'target', 'effect', 'sampler', 'frame'].map((name) => [
        name,
        // Each test's GPU double carries its factory fakes in `fns`.
        (gpu: any, ...args: any[]) => gpu.fns[name](...args),
      ]),
    ) as Record<string, unknown>,
);

vi.mock('lil-gui', () => ({ default: guiHarness.FakeGui }));
vi.mock('motion', () => ({
  frame: { postRender: motion.postRender },
  cancelFrame: motion.cancelFrame,
  frameData: motion.frameData,
}));
vi.mock('vgpu', () => ({
  init: mocks.init,
  ...vgpuFns,
  clock: (gpu: any) => gpu.clock,
}));

import { CARDS } from './cards';
import { createLayoutStore, type CardHandle, type LayoutStore } from './layout-store';
import { renderThumbnail } from './render-thumbnail';
import { createRenderer, sampleCards } from './renderer';

type Listener = (event?: unknown) => void;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function value(current: number) {
  return { get: () => current };
}

function handle(id: string, rect: { left: number; top: number; width: number; height: number }, rotate = 0): CardHandle {
  return {
    id,
    layer: 'grid',
    element: { getBoundingClientRect: () => rect },
    x: value(0),
    y: value(0),
    scale: value(1),
    rotate: value(rotate),
    present: true,
    hovered: false,
  };
}

function setup(options: { compile?: () => Promise<void>; reducedMotion?: boolean; width?: number } = {}) {
  const windowListeners = new Map<string, Listener>();
  const containerListeners = new Map<string, Listener>();
  const media = {
    matches: options.reducedMotion ?? false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  vi.stubGlobal('window', {
    matchMedia: vi.fn(() => media),
    addEventListener: vi.fn((name: string, listener: Listener) => windowListeners.set(name, listener)),
    removeEventListener: vi.fn((name: string) => windowListeners.delete(name)),
  });

  const container = {
    clientWidth: options.width ?? 1280,
    addEventListener: vi.fn((name: string, listener: Listener) => containerListeners.set(name, listener)),
    removeEventListener: vi.fn((name: string) => containerListeners.delete(name)),
  };
  const canvas = {
    parentElement: container,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 640, height: 360 }),
  } as unknown as HTMLCanvasElement;

  const targets: Array<{ size: readonly [number, number]; texelSize: readonly [number, number]; resize: ReturnType<typeof vi.fn> }> = [];
  const effects: Array<{ set: ReturnType<typeof vi.fn>; compile: ReturnType<typeof vi.fn> }> = [];
  const compile = vi.fn(options.compile ?? (async () => {}));
  const surface = {
    size: [1280, 720] as const,
    dpr: 2,
    format: 'rgba8unorm',
    onResize: vi.fn((callback: (event: { width: number; height: number; dpr: number }) => void) => {
      callback({ width: 1280, height: 720, dpr: 2 });
      return () => {};
    }),
  };
  const passes: Array<{ target: unknown }> = [];
  const frame = vi.fn((callback: (frame: { pass: typeof pass }) => void) => callback({ pass }));
  const pass = vi.fn((descriptor: { target: unknown }, body: (pass: { draw: () => void }) => void) => {
    passes.push(descriptor);
    body({ draw: vi.fn() });
  });
  const gpu = {
    gpu: { queue: { onSubmittedWorkDone: vi.fn(async () => {}) } },
    settled: vi.fn(async () => {}),
    dispose: vi.fn(),
    clock: { advance: vi.fn() },
    fns: {
      surface: vi.fn(() => surface),
      target: vi.fn((opts: { size: readonly [number, number] }) => {
        const created = {
          size: opts.size,
          texelSize: [1 / opts.size[0], 1 / opts.size[1]] as const,
          resize: vi.fn(),
        };
        targets.push(created);
        return created;
      }),
      effect: vi.fn(() => {
        const created = { set: vi.fn(), compile };
        effects.push(created);
        return created;
      }),
      sampler: vi.fn(() => ({})),
      frame,
    },
  };
  mocks.init.mockResolvedValueOnce(gpu);

  const store = createLayoutStore();
  return {
    canvas,
    container,
    containerListeners,
    windowListeners,
    media,
    targets,
    effects,
    compile,
    surface,
    passes,
    frame,
    gpu,
    store,
    tick(delta = 1000 / 60) {
      motion.frameData.delta = delta;
      const tick = motion.postRender.mock.calls.at(-1)?.[0] as (() => void) | undefined;
      tick?.();
    },
    play(seconds: number, delta = 50) {
      for (let elapsed = 0; elapsed < seconds * 1000; elapsed += delta) this.tick(delta);
    },
  };
}

function start(env: ReturnType<typeof setup>, store: LayoutStore = env.store) {
  return createRenderer({ canvas: env.canvas, container: env.container as unknown as HTMLElement, store });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  mocks.init.mockReset();
  motion.frameData.delta = 1000 / 60;
  guiHarness.instances.length = 0;
});

test('renders from Motion’s postRender with Motion’s delta and the live card rects', async () => {
  const env = setup();
  env.store.register(handle('surface', { left: 40, top: 60, width: 200, height: 240 }));
  const renderer = start(env);
  await renderer.ready;

  expect(mocks.init).toHaveBeenCalledOnce();
  expect(env.gpu.fns.surface).toHaveBeenCalledWith(env.canvas, { dpr: [1, 2] });
  // Every pass is compiled before the first frame; the output effect against the surface format.
  expect(env.compile).toHaveBeenCalledTimes(9);
  expect(env.compile).toHaveBeenCalledWith({ colors: ['rgba8unorm'] });
  expect(motion.postRender).toHaveBeenCalledOnce();
  expect(motion.postRender).toHaveBeenCalledWith(expect.any(Function), true);
  expect(env.frame).not.toHaveBeenCalled();

  env.tick(20);
  expect(env.gpu.clock.advance).toHaveBeenCalledWith(0.02);
  expect(env.frame).toHaveBeenCalledOnce();
  // backdrop → field → shade → bright → four blurs → composite into the surface.
  expect(env.passes).toHaveLength(9);
  expect(env.passes.at(-1)?.target).toBe(env.surface);
  const field = env.effects[1]!.set.mock.calls.at(-1)?.[0].field;
  expect(field.count).toBeGreaterThan(0);

  // A long stall (a background tab) advances the clock by at most 50 ms.
  env.tick(500);
  expect(env.gpu.clock.advance).toHaveBeenLastCalledWith(0.05);
  renderer.dispose();
});

test('the controls are a lil-gui panel in the container that drives the store and the look', async () => {
  const env = setup();
  const renderer = start(env);
  await renderer.ready;

  expect(guiHarness.instances).toHaveLength(1);
  const gui = guiHarness.instances[0]!;
  expect(gui.options).toMatchObject({ container: env.container, title: 'Liquid Layout' });
  expect(gui.domElement.style.position).toBe('absolute');
  expect(gui.controllers.map((control) => control.label)).toEqual(['Shuffle', 'Filter', 'Autoplay']);
  expect(gui.folders.map((folder) => (folder.options as { title: string }).title)).toEqual(['Liquid', 'Layout spring']);
  // Below 1440 px the open panel would cover a card, so it starts closed.
  expect(gui.close).toHaveBeenCalledOnce();
  expect(gui.folders[1]!.close).toHaveBeenCalledOnce();

  const order = env.store.getState().order;
  gui.press('Shuffle');
  expect(env.store.getState().order).not.toEqual(order);

  gui.set('Filter', 'vgpu');
  expect(env.store.getState().filter).toBe('vgpu');
  expect(new Set(env.store.visible())).toEqual(new Set(CARDS.filter((card) => card.library === 'vgpu').map((card) => card.id)));
  // A filter change from elsewhere (the autoplay) shows up in the panel.
  const filter = gui.control('Filter');
  env.store.setFilter('motion');
  expect(filter.model.filter).toBe('motion');
  expect(filter.updateDisplay).toHaveBeenCalledOnce();

  const shade = env.effects[2]!;
  gui.set('Refraction', 12);
  expect(shade.set.mock.calls.at(-1)?.[0].shade).toMatchObject({ refraction: 12 });
  gui.set('Stiffness', 320);
  expect(env.store.getState().stiffness).toBe(320);
  renderer.dispose();
});

test('the panel starts open on wide containers', async () => {
  const env = setup({ width: 1600 });
  const renderer = start(env);
  await renderer.ready;
  expect(guiHarness.instances[0]!.close).not.toHaveBeenCalled();
  renderer.dispose();
});

test('autoplay starts after its first pause and waits while the user interacts', async () => {
  const env = setup();
  const renderer = start(env);
  await renderer.ready;
  const initial = env.store.getState().order;

  env.play(2.4);
  expect(env.store.getState().order).toBe(initial);
  env.play(0.4);
  expect(env.store.getState().order).not.toBe(initial);

  // Input pauses the choreography for six seconds.
  const shuffled = env.store.getState().order;
  env.containerListeners.get('pointerdown')?.();
  env.windowListeners.get('pointerup')?.();
  env.play(5.5);
  expect(env.store.getState().order).toBe(shuffled);
  env.play(4);
  expect(env.store.getState().order).not.toBe(shuffled);

  // A panel the user opened holds the autoplay until it closes.
  env.store.expand('drag', 'user');
  const held = env.store.getState();
  env.play(12);
  expect(env.store.getState()).toBe(held);
  renderer.dispose();
});

test('reduced motion turns the autoplay off', async () => {
  const env = setup({ reducedMotion: true });
  const renderer = start(env);
  await renderer.ready;
  const state = env.store.getState();
  env.play(12);
  expect(env.store.getState()).toBe(state);
  expect(guiHarness.instances[0]!.control('Autoplay').model.autoplay).toBe(false);
  renderer.dispose();
});

test('dispose is idempotent and releases the frame callback, listeners and the GUI', async () => {
  const env = setup();
  const renderer = start(env);
  await renderer.ready;
  const tick = motion.postRender.mock.calls[0]![0];
  expect(env.containerListeners.size).toBe(5);
  expect(env.windowListeners.size).toBe(2);
  expect(env.media.addEventListener).toHaveBeenCalledWith('change', expect.any(Function));
  const filter = guiHarness.instances[0]!.control('Filter');

  renderer.dispose();
  renderer.dispose();
  expect(motion.cancelFrame).toHaveBeenCalledOnce();
  expect(motion.cancelFrame).toHaveBeenCalledWith(tick);
  expect(env.containerListeners.size).toBe(0);
  expect(env.windowListeners.size).toBe(0);
  expect(env.media.removeEventListener).toHaveBeenCalledWith('change', expect.any(Function));
  expect(guiHarness.instances[0]!.destroy).toHaveBeenCalledOnce();
  expect(env.gpu.dispose).toHaveBeenCalledOnce();

  // Nothing reacts after teardown: no frames, no panel updates.
  env.tick();
  expect(env.frame).not.toHaveBeenCalled();
  env.store.setFilter('vgpu');
  expect(filter.updateDisplay).not.toHaveBeenCalled();
});

test('disposes a stale GPU initialization without creating resources', async () => {
  const env = setup();
  const init = deferred<typeof env.gpu>();
  mocks.init.mockReset().mockReturnValueOnce(init.promise);
  const renderer = start(env);
  await vi.waitFor(() => expect(mocks.init).toHaveBeenCalledOnce());
  renderer.dispose();
  init.resolve(env.gpu);
  await renderer.ready;
  expect(env.gpu.dispose).toHaveBeenCalledOnce();
  expect(env.gpu.fns.surface).not.toHaveBeenCalled();
  expect(motion.postRender).not.toHaveBeenCalled();
});

test('dispose during prewarm stops before anything is registered', async () => {
  const compiled = deferred<void>();
  const env = setup({ compile: () => compiled.promise });
  const renderer = start(env);
  await vi.waitFor(() => expect(env.compile).toHaveBeenCalled());
  renderer.dispose();
  compiled.resolve();
  await renderer.ready;
  expect(env.gpu.dispose).toHaveBeenCalledOnce();
  expect(env.containerListeners.size).toBe(0);
  expect(env.windowListeners.size).toBe(0);
  expect(guiHarness.instances).toHaveLength(0);
  expect(motion.postRender).not.toHaveBeenCalled();
  expect(motion.cancelFrame).not.toHaveBeenCalled();
});

test('an initialization failure rejects ready and tears down', async () => {
  const env = setup({
    compile: async () => {
      throw new Error('compile failed');
    },
  });
  const renderer = start(env);
  await expect(renderer.ready).rejects.toThrow('compile failed');
  expect(env.gpu.dispose).toHaveBeenCalledOnce();
  expect(env.containerListeners.size).toBe(0);
  expect(guiHarness.instances).toHaveLength(0);
  expect(motion.postRender).not.toHaveBeenCalled();
});

test('a missing GUI container fails initialization and tears down', async () => {
  const env = setup();
  (env.canvas as unknown as { parentElement: unknown }).parentElement = null;
  const renderer = createRenderer({ canvas: env.canvas, store: env.store });
  await expect(renderer.ready).rejects.toThrow('needs a GUI container');
  expect(env.gpu.dispose).toHaveBeenCalledOnce();
  expect(env.windowListeners.size).toBe(0);
  expect(motion.postRender).not.toHaveBeenCalled();
});

test('sampleCards recovers the unrotated card size and marks lifted cards', () => {
  const store = createLayoutStore();
  // A 200 × 100 card rotated by 30° has a 223.2 × 186.6 bounding box.
  const angle = Math.PI / 6;
  const width = 200 * Math.cos(angle) + 100 * Math.sin(angle);
  const height = 200 * Math.sin(angle) + 100 * Math.cos(angle);
  store.register(handle('drag', { left: 110, top: 70, width, height }, 30));
  store.register({ ...handle('layout', { left: 400, top: 100, width: 300, height: 200 }), layer: 'panel' });
  store.register({ ...handle('effect', { left: 0, top: 0, width: 0, height: 0 }) });

  const [dragged, panel, ...rest] = sampleCards(store, { left: 10, top: 20 });
  expect(rest).toHaveLength(0);
  expect(dragged!.cx).toBeCloseTo(100 + width / 2, 6);
  expect(dragged!.cy).toBeCloseTo(50 + height / 2, 6);
  expect(dragged!.hw).toBeCloseTo(100, 6);
  expect(dragged!.hh).toBeCloseTo(50, 6);
  expect(dragged!.rotation).toBeCloseTo(angle, 6);
  expect(dragged!.lifted).toBe(false);
  expect(panel!.lifted).toBe(true);
  expect(panel!.hue).toBe(1);

  // A card flying back from the panel stays on top until it settles.
  store.expand('drag');
  store.collapse();
  expect(sampleCards(store, { left: 0, top: 0 })[0]!.lifted).toBe(true);
  store.settle('drag');
  expect(sampleCards(store, { left: 0, top: 0 })[0]!.lifted).toBe(false);
});

test('the thumbnail renders its last frames and waits for both GPU drains', async () => {
  const env = setup();
  const drained = deferred<void>();
  const settled = deferred<void>();
  env.gpu.gpu.queue.onSubmittedWorkDone = vi.fn(() => drained.promise);
  env.gpu.settled = vi.fn(() => settled.promise);
  const output = { size: [320, 180] as const, format: 'rgba8unorm' };

  let done = false;
  const run = renderThumbnail(env.gpu as never, output as never, { warmupFrames: 3, time: 1 }).then(() => {
    done = true;
  });
  await vi.waitFor(() => expect(env.gpu.settled).toHaveBeenCalledOnce());
  expect(env.frame).toHaveBeenCalledTimes(3);
  expect(env.passes.at(-1)?.target).toBe(output);
  expect(env.compile).toHaveBeenCalledWith({ colors: ['rgba8unorm'] });
  // The scene is laid out at 1280 × 720 CSS px whatever the output size.
  expect(env.effects[1]!.set.mock.calls[0]?.[0].field.viewport).toEqual([1280, 720]);
  expect(env.gpu.gpu.queue.onSubmittedWorkDone).toHaveBeenCalledOnce();

  drained.resolve();
  await Promise.resolve();
  await Promise.resolve();
  expect(done).toBe(false);
  settled.resolve();
  await run;
  expect(done).toBe(true);
  expect(env.gpu.dispose).not.toHaveBeenCalled();
});

test('the thumbnail still drains the GPU when prewarm fails', async () => {
  const env = setup({
    compile: async () => {
      throw new Error('compile failed');
    },
  });
  const output = { size: [320, 180] as const, format: 'rgba8unorm' };
  await expect(renderThumbnail(env.gpu as never, output as never)).rejects.toThrow('compile failed');
  expect(env.gpu.gpu.queue.onSubmittedWorkDone).toHaveBeenCalledOnce();
  expect(env.gpu.settled).toHaveBeenCalledOnce();
  expect(env.frame).not.toHaveBeenCalled();
  expect(env.gpu.dispose).not.toHaveBeenCalled();
});
