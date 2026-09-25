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
    name(label: string): Control;
    onChange(change: (value: unknown) => unknown): Control;
  }
  class FakeGui {
    options: unknown;
    // Closed at the top right of the 640×360 test canvas.
    rect = { left: 474, top: 16, width: 150, height: 36 };
    domElement = {
      style: {
        properties: {} as Record<string, string>,
        setProperty(name: string, value: string) {
          this.properties[name] = value;
        },
      } as Record<string, any>,
      getBoundingClientRect: () => this.rect,
    };
    destroy = vi.fn();
    _closed = false;
    openClose?: (changed: FakeGui) => void;
    onOpenClose(callback: (changed: FakeGui) => void) {
      this.openClose = callback;
      return this;
    }
    open = vi.fn((open = true) => {
      this._closed = !open;
      this.openClose?.(this);
      return this;
    });
    close = vi.fn(() => this.open(false));
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
vi.mock('motion', async (importOriginal) => ({
  // The thumbnail coasts with Motion's real inertia generator.
  ...(await importOriginal<typeof import('motion')>()),
  frame: { postRender: motion.postRender },
  cancelFrame: motion.cancelFrame,
  frameData: motion.frameData,
}));
vi.mock('vgpu', () => ({
  init: mocks.init,
  ...vgpuFns,
  clock: (gpu: any) => gpu.clock,
}));

import { fluidSize, PRESSURE_ITERATIONS } from './fluid';
import { createOrbStore, type OrbHandle, type RectLike } from './orb-store';
import type { TrackedOrb } from './orb-tracker';
import { renderThumbnail } from './render-thumbnail';
import { createRenderer, distanceToWall, flickVelocity } from './renderer';

type Listener = (event?: unknown) => void;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const CANVAS: RectLike = { left: 0, top: 0, width: 640, height: 360 };
/** Curl, forces, divergence, the Jacobi iterations, projection, dye, and the composite. */
const PASSES_PER_FRAME = 3 + PRESSURE_ITERATIONS + 2 + 1;

function orbHandle(rect: RectLike = { left: 200, top: 120, width: 120, height: 120 }) {
  return {
    element: { getBoundingClientRect: () => rect },
    bounds: { getBoundingClientRect: () => CANVAS },
    scale: { get: () => 1 },
    flick: vi.fn(),
  } satisfies OrbHandle;
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
    contains: (_node: unknown) => false,
  };
  const canvas = {
    parentElement: container,
    getBoundingClientRect: () => CANVAS,
  } as unknown as HTMLCanvasElement;

  const targets: Array<{
    label: string;
    size: readonly [number, number];
    texelSize: readonly [number, number];
    resize: ReturnType<typeof vi.fn>;
  }> = [];
  const effects: Array<{ label: string; set: ReturnType<typeof vi.fn>; compile: ReturnType<typeof vi.fn> }> = [];
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
  const passes: Array<{ target: unknown; effect: unknown }> = [];
  const pass = vi.fn((target: unknown, effect: unknown) => {
    passes.push({ target, effect });
  });
  const frame = vi.fn((callback: (frame: { pass: typeof pass }) => void) => callback({ pass }));
  const gpu = {
    gpu: { queue: { onSubmittedWorkDone: vi.fn(async () => {}) } },
    settled: vi.fn(async () => {}),
    dispose: vi.fn(),
    clock: { advance: vi.fn() },
    fns: {
      surface: vi.fn(() => surface),
      target: vi.fn((opts: { size: readonly [number, number]; label: string }) => {
        const created = {
          label: opts.label,
          size: opts.size,
          texelSize: [1 / opts.size[0], 1 / opts.size[1]] as const,
          resize: vi.fn(),
        };
        targets.push(created);
        return created;
      }),
      effect: vi.fn((_shader: unknown, opts: { label: string }) => {
        const created = { label: opts.label, set: vi.fn(), compile };
        effects.push(created);
        return created;
      }),
      sampler: vi.fn(() => ({})),
      frame,
    },
  };
  mocks.init.mockResolvedValueOnce(gpu);

  const store = createOrbStore();
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
    effect(name: string) {
      const found = effects.find((candidate) => candidate.label === `throwable-fluid-${name}`);
      if (!found) throw new Error(`No effect ${name}`);
      return found;
    },
    target(name: string) {
      const found = targets.find((candidate) => candidate.label === `throwable-fluid-${name}`);
      if (!found) throw new Error(`No target ${name}`);
      return found;
    },
    /** The last value `key` was set to on any of the effects called `names`. */
    lastSet(names: string | readonly string[], key: string) {
      let latest: { order: number; value: any } | undefined;
      for (const name of typeof names === 'string' ? [names] : names) {
        const { calls, invocationCallOrder } = this.effect(name).set.mock;
        calls.forEach((call, i) => {
          const order = invocationCallOrder[i]!;
          if (key in call[0] && (!latest || order > latest.order)) latest = { order, value: call[0][key] };
        });
      }
      return latest?.value;
    },
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

function start(env: ReturnType<typeof setup>) {
  return createRenderer({ canvas: env.canvas, container: env.container as unknown as HTMLElement, store: env.store });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  mocks.init.mockReset();
  motion.frameData.delta = 1000 / 60;
  guiHarness.instances.length = 0;
});

test('steps the fluid and draws the orb from Motion’s postRender, with Motion’s delta', async () => {
  const env = setup();
  env.store.register(orbHandle());
  const renderer = start(env);
  await renderer.ready;

  expect(mocks.init).toHaveBeenCalledOnce();
  expect(env.gpu.fns.surface).toHaveBeenCalledWith(env.canvas, { dpr: [1, 2] });
  // Every pass is compiled before the first frame; the composites against the surface format.
  expect(env.compile).toHaveBeenCalledTimes(15);
  expect(env.compile).toHaveBeenCalledWith({ colors: ['rgba8unorm'] });
  expect(motion.postRender).toHaveBeenCalledOnce();
  expect(motion.postRender).toHaveBeenCalledWith(expect.any(Function), true);
  expect(env.frame).not.toHaveBeenCalled();

  env.tick(20);
  expect(env.gpu.clock.advance).toHaveBeenCalledWith(0.02);
  expect(env.frame).toHaveBeenCalledOnce();
  expect(env.passes).toHaveLength(PASSES_PER_FRAME);
  expect(env.passes.at(-1)?.target).toBe(env.surface);
  // The orb's centre, in the solver's uv.
  expect(env.lastSet('advect-velocity', 'stir').segmentEnd).toEqual([260 / 640, 180 / 360]);
  expect(env.lastSet('composite-1', 'view')).toMatchObject({ orbVisible: 1, orbCenter: [520, 360], orbRadius: 120 });

  // A long stall (a background tab) advances the clock by at most 50 ms, in two solver substeps.
  env.tick(500);
  expect(env.gpu.clock.advance).toHaveBeenLastCalledWith(0.05);
  expect(env.passes).toHaveLength(PASSES_PER_FRAME * 3 - 1);
  renderer.dispose();
});

test('without a mounted orb the ink still flows and the lens is hidden', async () => {
  const env = setup();
  const renderer = start(env);
  await renderer.ready;
  env.tick();
  expect(env.passes).toHaveLength(PASSES_PER_FRAME);
  expect(env.lastSet('composite-1', 'view').orbVisible).toBe(0);
  expect(env.lastSet('advect-dye-a', 'ink').amount).toBe(0);
  renderer.dispose();
});

test('the lil-gui panel drives the fluid, the lens and Motion’s throw physics', async () => {
  const env = setup();
  const handle = orbHandle();
  env.store.register(handle);
  const renderer = start(env);
  await renderer.ready;

  expect(guiHarness.instances).toHaveLength(1);
  const gui = guiHarness.instances[0]!;
  expect(gui.options).toMatchObject({ container: env.container, title: 'Throwable Fluid' });
  expect(gui.domElement.style.position).toBe('absolute');
  expect(gui.controllers.map((control) => control.label)).toEqual(['Flick the orb', 'Clear the ink', 'Idle flicks']);
  expect(gui.folders.map((folder) => (folder.options as { title: string }).title)).toEqual([
    'Fluid',
    'Orb',
    'Throw (Motion)',
  ]);
  // Below 1440 px the open panel covers the top-right of the tank, so it starts
  // closed, shrunk to its title, and widens again when opened.
  expect(gui.close).toHaveBeenCalledOnce();
  expect(gui.domElement.style.properties['--width']).toBe('150px');
  gui.open();
  expect(gui.domElement.style.properties['--width']).toBe('230px');

  gui.set('Viscosity', 0.1);
  gui.set('Refraction', 2);
  env.tick();
  expect(env.lastSet('advect-velocity', 'stir').viscosity).toBe(0.1);
  expect(env.lastSet('composite-1', 'view').refraction).toBe(2);

  // Throw physics and the orb size go to the React orb through the store.
  gui.set('Power', 0.9);
  gui.set('Bounce stiffness', 300);
  gui.set('Size', 150);
  expect(env.store.getState()).toMatchObject({ power: 0.9, bounceStiffness: 300, size: 150 });

  // A new resolution refits every field at once, outside Motion's frame.
  const frames = env.frame.mock.calls.length;
  gui.set('Resolution', 'high');
  expect(env.target('velocity-a').resize).toHaveBeenCalledWith(fluidSize(1280, 720, 'high').grid);
  expect(env.target('dye-a').resize).toHaveBeenCalledWith(fluidSize(1280, 720, 'high').dye);
  expect(env.frame).toHaveBeenCalledTimes(frames + 2);

  gui.press('Flick the orb');
  expect(handle.flick).toHaveBeenCalledOnce();
  const [vx, vy] = handle.flick.mock.calls[0]!;
  expect(Math.hypot(vx, vy)).toBeGreaterThan(0);

  // Clearing lays no new ink and fades what is there fast.
  gui.press('Clear the ink');
  env.tick();
  const ink = env.lastSet(['advect-dye-a', 'advect-dye-b'], 'ink');
  expect(ink.amount).toBe(0);
  expect(ink.dissipation).toBeGreaterThan(5);
  renderer.dispose();
});

test('the closed panel turns see-through while the orb sits under it', async () => {
  const env = setup();
  const rect = { left: 200, top: 120, width: 120, height: 120 };
  env.store.register(orbHandle(rect));
  const renderer = start(env);
  await renderer.ready;
  const gui = guiHarness.instances[0]!;
  const opacity = () => gui.domElement.style.opacity ?? '';

  env.tick();
  expect(opacity()).toBe('');
  // Resting in the top-right corner, under the closed title bar.
  Object.assign(rect, { left: 520, top: 0 });
  env.tick();
  expect(opacity()).toBe('0.35');
  // Opened, the panel is what the visitor is looking at.
  gui.open();
  env.tick();
  expect(opacity()).toBe('');
  gui.close();
  env.tick();
  expect(opacity()).toBe('0.35');
  // The box corner reaches the panel but the round orb does not.
  Object.assign(rect, { left: 360, top: 50 });
  env.tick();
  expect(opacity()).toBe('');
  renderer.dispose();
});

test('the panel starts open on wide containers', async () => {
  const env = setup({ width: 1600 });
  const renderer = start(env);
  await renderer.ready;
  expect(guiHarness.instances[0]!.close).not.toHaveBeenCalled();
  renderer.dispose();
});

test('idle flicks start soon after load and pause for six seconds after input', async () => {
  const env = setup();
  const handle = orbHandle();
  env.store.register(handle);
  const renderer = start(env);
  await renderer.ready;

  env.play(0.8);
  expect(handle.flick).not.toHaveBeenCalled();
  env.play(0.2);
  expect(handle.flick).toHaveBeenCalledOnce();

  env.containerListeners.get('pointerdown')?.();
  env.windowListeners.get('pointerup')?.();
  env.play(5.5);
  expect(handle.flick).toHaveBeenCalledOnce();
  env.play(1);
  expect(handle.flick).toHaveBeenCalledTimes(2);

  // The next flick waits its turn, spread round the tank by the golden angle.
  env.play(2.5);
  expect(handle.flick).toHaveBeenCalledTimes(2);
  env.play(1);
  expect(handle.flick).toHaveBeenCalledTimes(3);
  const [a, b] = handle.flick.mock.calls.slice(1) as [number, number][];
  expect(Math.atan2(a[1], a[0])).not.toBeCloseTo(Math.atan2(b[1], b[0]), 1);
  renderer.dispose();
});

test('a hovering mouse, a press on the orb, a drag or keyboard focus hold the idle flicks', async () => {
  const env = setup();
  const handle = orbHandle();
  env.store.register(handle);
  const renderer = start(env);
  await renderer.ready;

  env.containerListeners.get('pointermove')?.({ pointerType: 'mouse' });
  env.play(12);
  expect(handle.flick).not.toHaveBeenCalled();
  env.containerListeners.get('pointerleave')?.();

  // A touch moving over the demo only pauses it.
  env.containerListeners.get('pointermove')?.({ pointerType: 'touch' });
  env.play(5.5);
  expect(handle.flick).not.toHaveBeenCalled();
  env.play(1);
  expect(handle.flick).toHaveBeenCalledOnce();

  for (const flag of ['hovered', 'pressed', 'dragging'] as const) {
    env.store.interaction[flag] = true;
    env.play(12);
    expect(handle.flick).toHaveBeenCalledOnce();
    env.store.interaction[flag] = false;
  }

  // Someone tabbed to the orb: it never moves under the focus ring.
  const orb = { matches: (selector: string) => selector === ':focus-visible' };
  const body = {};
  vi.stubGlobal('document', { activeElement: orb, body });
  env.container.contains = (node) => node === orb;
  env.play(12);
  expect(handle.flick).toHaveBeenCalledOnce();
  renderer.dispose();
});

test('the Idle flicks checkbox turns the choreography off', async () => {
  const env = setup();
  const handle = orbHandle();
  env.store.register(handle);
  const renderer = start(env);
  await renderer.ready;
  guiHarness.instances[0]!.set('Idle flicks', false);
  env.play(12);
  expect(handle.flick).not.toHaveBeenCalled();
  renderer.dispose();
});

test('reduced motion reaches the store and softens the idle flicks', async () => {
  const env = setup({ reducedMotion: true });
  const handle = orbHandle();
  env.store.register(handle);
  const renderer = start(env);
  await renderer.ready;
  expect(env.store.getState().reduced).toBe(true);

  env.play(1);
  expect(handle.flick).toHaveBeenCalledOnce();
  // The orb coasts short of the wall ahead instead of splashing into it.
  const [vx, vy] = handle.flick.mock.calls[0]!;
  const coast = Math.hypot(vx, vy) * env.store.getState().power;
  expect(coast).toBeLessThan(Math.max(CANVAS.width, CANVAS.height));
  // And flicks come less often.
  env.play(4.5);
  expect(handle.flick).toHaveBeenCalledOnce();

  const onChange = env.media.addEventListener.mock.calls[0]![1] as () => void;
  env.media.matches = false;
  onChange();
  expect(env.store.getState().reduced).toBe(false);
  renderer.dispose();
});

test('a ripple swirls the ink round the orb', async () => {
  const env = setup();
  env.store.register(orbHandle());
  const renderer = start(env);
  await renderer.ready;
  env.tick();
  expect(env.lastSet('advect-velocity', 'stir').splashSwirl).toBe(0);

  env.store.requestRipple();
  env.tick();
  const stir = env.lastSet('advect-velocity', 'stir');
  expect(stir.splashSwirl).not.toBe(0);
  expect(stir.splashCenter).toEqual([260 / 640, 180 / 360]);
  expect(env.lastSet('advect-dye-b', 'ink').splashArms).toBeGreaterThan(0);
  renderer.dispose();
});

test('a canvas resize refits the fluid on the next tick, never inside the resize callback', async () => {
  const env = setup();
  env.store.register(orbHandle());
  const renderer = start(env);
  await renderer.ready;
  const onResize = env.surface.onResize.mock.calls[0]![0];
  onResize({ width: 640, height: 720, dpr: 2 });
  expect(env.frame).not.toHaveBeenCalled();
  expect(env.target('velocity-a').resize).not.toHaveBeenCalled();

  env.tick();
  const next = fluidSize(640, 720, 'medium');
  expect(env.target('velocity-a').resize).toHaveBeenCalledWith(next.grid);
  expect(env.target('dye-b').resize).toHaveBeenCalledWith(next.dye);
  // Two stretch copies, then the frame itself.
  expect(env.frame).toHaveBeenCalledTimes(3);
  // Everything jumped at once, so the orb reports no velocity that frame.
  expect(env.lastSet('advect-velocity', 'stir').orbVelocity).toEqual([0, 0]);
  renderer.dispose();
});

test('a frame that throws stops the renderer once and reports the error', async () => {
  const env = setup();
  const renderer = start(env);
  await renderer.ready;
  const tick = motion.postRender.mock.calls[0]![0];
  const reported: Array<() => void> = [];
  vi.stubGlobal('queueMicrotask', (callback: () => void) => reported.push(callback));
  env.frame.mockImplementationOnce(() => {
    throw new Error('device lost');
  });

  env.tick();
  expect(motion.cancelFrame).toHaveBeenCalledWith(tick);
  expect(env.gpu.dispose).toHaveBeenCalledOnce();
  expect(guiHarness.instances[0]!.destroy).toHaveBeenCalledOnce();
  expect(reported).toHaveLength(1);
  expect(() => reported[0]!()).toThrow('device lost');

  // Motion's pending call after the cancel does nothing.
  env.tick();
  expect(env.frame).toHaveBeenCalledOnce();
  expect(reported).toHaveLength(1);
  renderer.dispose();
  expect(env.gpu.dispose).toHaveBeenCalledOnce();
});

test('dispose is idempotent and releases the frame callback, listeners and the GUI', async () => {
  const env = setup();
  const renderer = start(env);
  await renderer.ready;
  const tick = motion.postRender.mock.calls[0]![0];
  expect(env.containerListeners.size).toBe(5);
  expect(env.windowListeners.size).toBe(2);
  expect(env.media.addEventListener).toHaveBeenCalledWith('change', expect.any(Function));

  renderer.dispose();
  renderer.dispose();
  expect(motion.cancelFrame).toHaveBeenCalledOnce();
  expect(motion.cancelFrame).toHaveBeenCalledWith(tick);
  expect(env.containerListeners.size).toBe(0);
  expect(env.windowListeners.size).toBe(0);
  expect(env.media.removeEventListener).toHaveBeenCalledWith('change', expect.any(Function));
  expect(guiHarness.instances[0]!.destroy).toHaveBeenCalledOnce();
  expect(env.gpu.dispose).toHaveBeenCalledOnce();

  env.tick();
  expect(env.frame).not.toHaveBeenCalled();
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

function tracked(center: readonly [number, number], radius = 60): TrackedOrb {
  return { center, previous: center, velocity: [0, 0], speed: 0, radius, radii: [radius, radius], lift: 0, contacts: [] };
}

test('distanceToWall measures along the direction to the first wall the orb would touch', () => {
  expect(distanceToWall([100, 100], [1, 0], 20, [400, 300])).toBe(280);
  expect(distanceToWall([100, 100], [0, -1], 20, [400, 300])).toBe(80);
  expect(distanceToWall([100, 100], [Math.SQRT1_2, Math.SQRT1_2], 20, [400, 300])).toBeCloseTo(180 * Math.SQRT2, 6);
  // Already past it: nothing left to travel.
  expect(distanceToWall([390, 100], [1, 0], 20, [400, 300])).toBe(0);
});

test('an idle flick splashes into one wall and stops short of the other', () => {
  const view = [640, 360] as const;
  const power = 0.6;
  const [vx, vy] = flickVelocity(tracked([320, 180]), view, Math.PI / 4, power, 3);
  // The bottom wall comes first: the coast carries the orb past it.
  expect(vy * power).toBeGreaterThan(360 - 60 - 180);
  // The right wall would come later: that axis stops short, so the orb does not park in the corner.
  expect(vx).toBeGreaterThan(0);
  expect(vx * power).toBeLessThanOrEqual(0.8 * (640 - 60 - 320) + 1e-9);

  // Straight along one axis there is no other wall to stop short of.
  const [straight] = flickVelocity(tracked([320, 180]), view, 0, power, 3);
  expect(straight * power).toBeCloseTo(3 * (640 - 60 - 320), 6);
});

test('a flick at a wall the orb is resting against goes the other way', () => {
  const [vx] = flickVelocity(tracked([560, 180]), [640, 360], 0, 0.6, 3);
  expect(vx).toBeLessThan(0);
});

test('under reduced motion the flick coasts short of the wall ahead', () => {
  const power = 0.6;
  const [vx] = flickVelocity(tracked([320, 180]), [640, 360], 0, power, 0.6);
  expect(vx * power).toBeLessThan(640 - 60 - 320);
});

test('the thumbnail renders its last frames and waits for both GPU drains', async () => {
  const env = setup();
  const drained = deferred<void>();
  const settled = deferred<void>();
  env.gpu.gpu.queue.onSubmittedWorkDone = vi.fn(() => drained.promise);
  env.gpu.settled = vi.fn(() => settled.promise);
  const output = { size: [320, 180] as const, format: 'rgba8unorm' };

  let done = false;
  const run = renderThumbnail(env.gpu as never, output as never, { warmupFrames: 3, time: 0.1 }).then(() => {
    done = true;
  });
  await vi.waitFor(() => expect(env.gpu.settled).toHaveBeenCalledOnce());
  // The throw plays from its start; only the last warm-up frames are drawn.
  expect(env.frame).toHaveBeenCalledTimes(6);
  expect(env.passes.filter((pass) => pass.target === output)).toHaveLength(3);
  expect(env.passes.at(-1)?.target).toBe(output);
  expect(env.compile).toHaveBeenCalledWith({ colors: ['rgba8unorm'] });
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
