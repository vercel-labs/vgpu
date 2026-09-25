import { afterEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ init: vi.fn() }));
const motion = vi.hoisted(() => {
  class FakeValue {
    current: number;
    velocity = 0;
    destroy = vi.fn();
    constructor(initial: number) {
      this.current = initial;
    }
    get() {
      return this.current;
    }
    set(next: number) {
      this.current = next;
    }
    jump(next: number) {
      this.current = next;
    }
    getVelocity() {
      return this.velocity;
    }
  }
  /** A spring that has already arrived: it reads its source. */
  class FakeSpring extends FakeValue {
    source: FakeValue;
    constructor(source: FakeValue) {
      super(source.get());
      this.source = source;
    }
    override get() {
      return this.source.get();
    }
  }
  interface Timeline {
    sequence: unknown[];
    options: unknown;
    controls: { time: number; speed: number; play: ReturnType<typeof vi.fn>; pause: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> };
  }
  interface Tween {
    from: number;
    to: number;
    options: { onUpdate: (value: number) => void; onComplete: () => void };
    stop: ReturnType<typeof vi.fn>;
  }
  const values: FakeValue[] = [];
  const timelines: Timeline[] = [];
  const tweens: Tween[] = [];
  return {
    FakeValue,
    values,
    timelines,
    tweens,
    render: vi.fn(),
    cancelFrame: vi.fn(),
    frameData: { delta: 1000 / 60 },
    motionValue: vi.fn((initial: number) => {
      const value = new FakeValue(initial);
      values.push(value);
      return value;
    }),
    springValue: vi.fn((source: FakeValue) => {
      const value = new FakeSpring(source);
      values.push(value);
      return value;
    }),
    animate: vi.fn((subject: unknown, keyframes: unknown, options?: unknown) => {
      if (Array.isArray(subject)) {
        // The timeline: Motion writes its time into the playhead value.
        const playhead = (subject[1] as [InstanceType<typeof FakeValue>])[0];
        let time = 0;
        const controls = {
          speed: 1,
          play: vi.fn(),
          pause: vi.fn(),
          stop: vi.fn(),
          get time() {
            return time;
          },
          set time(next: number) {
            time = next;
            playhead.set(next);
          },
        };
        timelines.push({ sequence: subject, options: keyframes, controls });
        return controls;
      }
      const tween = { from: subject as number, to: keyframes as number, options: options as Tween['options'], stop: vi.fn() };
      tweens.push(tween);
      return tween;
    }),
  };
});
const guiHarness = vi.hoisted(() => {
  interface Control {
    model: Record<string, unknown>;
    property: string;
    label?: string;
    change?: (value: unknown) => unknown;
    finish?: (value: unknown) => unknown;
    updateDisplay: ReturnType<typeof vi.fn>;
    name(label: string): Control;
    onChange(change: (value: unknown) => unknown): Control;
    onFinishChange(finish: (value: unknown) => unknown): Control;
  }
  class FakeGui {
    options: { title?: string; container?: unknown };
    domElement = { style: {} as Record<string, string> };
    destroy = vi.fn();
    close = vi.fn();
    folders: FakeGui[] = [];
    // Every control in the tree, for lookups by label.
    all: Control[];

    constructor(options: FakeGui['options'], root?: FakeGui) {
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
        onFinishChange(finish) {
          control.finish = finish;
          return control;
        },
      };
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

    finish(label: string) {
      const control = this.control(label);
      control.finish?.(control.model[control.property]);
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
      ['surface', 'target', 'effect', 'draw', 'compute', 'storage', 'sampler', 'frame'].map((name) => [
        name,
        // Each test's GPU double carries its factory fakes in `fns`.
        (gpu: any, ...args: any[]) => gpu.fns[name](...args),
      ]),
    ) as Record<string, unknown>,
);

vi.mock('lil-gui', () => ({ default: guiHarness.FakeGui }));
vi.mock('motion', async (importOriginal) => ({
  // The choreography bakes Motion's real spring() and stagger().
  ...(await importOriginal<typeof import('motion')>()),
  animate: motion.animate,
  motionValue: motion.motionValue,
  springValue: motion.springValue,
  frame: { render: motion.render },
  cancelFrame: motion.cancelFrame,
  frameData: motion.frameData,
}));
vi.mock('vgpu', () => ({
  init: mocks.init,
  ...vgpuFns,
  clock: (gpu: any) => gpu.clock,
}));

import {
  DEFAULT_SPRING,
  DEFAULT_STAGGER,
  LOOP,
  MAX_ACTIVE,
  SEGMENT,
  SHAPES,
  SPRING_PRESETS,
  SPRING_SAMPLES,
  arrivalCue,
  bakeSpring,
  criticallyDamped,
} from './choreography';
import { DEFAULT_COUNT, PARTICLE_COUNTS } from './pipeline';
import { renderThumbnail } from './render-thumbnail';
import { createRenderer, jumpDelta, timelineSequence } from './renderer';

type Listener = (event?: unknown) => void;
type Fake = { label?: string; set: ReturnType<typeof vi.fn>; compile: ReturnType<typeof vi.fn> };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Deep-merged view of every `set()` a fake received, like vgpu's partial updates. */
function merged(fake: Fake): Record<string, any> {
  const state: Record<string, any> = {};
  for (const [values] of fake.set.mock.calls) {
    for (const [key, value] of Object.entries(values as Record<string, unknown>)) {
      state[key] =
        value && typeof value === 'object' && !ArrayBuffer.isView(value) && !Array.isArray(value) && !('write' in value)
          ? { ...state[key], ...value }
          : value;
    }
  }
  return state;
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
    clientWidth: 640,
    clientHeight: 360,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 640, height: 360 }),
  } as unknown as HTMLCanvasElement;

  const fakes: Fake[] = [];
  const storages: Array<{ size: number; write: ReturnType<typeof vi.fn> }> = [];
  const compile = vi.fn(options.compile ?? (async () => {}));
  const make = (opts: { label?: string; set?: Record<string, unknown> }): Fake => {
    const fake = { label: opts.label, set: vi.fn(), compile };
    // Record the initial bindings so merged() sees them too.
    if (opts.set) fake.set(opts.set);
    fakes.push(fake);
    return fake;
  };
  const surface = {
    size: [1280, 720] as const,
    format: 'rgba8unorm',
    onResize: vi.fn((callback: (event: { width: number; height: number; dpr: number }) => void) => {
      callback({ width: 1280, height: 720, dpr: 2 });
      return unsubscribeResize;
    }),
  };
  const unsubscribeResize = vi.fn();
  const passes: Array<{ target: unknown; clear: unknown; draws: unknown[] }> = [];
  const dispatches: Array<[unknown, number]> = [];
  const frame = vi.fn((callback: (frame: unknown) => void) =>
    callback({
      computePass: (body: (pass: unknown) => void) =>
        body({ dispatch: (kernel: unknown, groups: number) => dispatches.push([kernel, groups]) }),
      pass: (descriptor: { target: unknown; clear: unknown }, body: (pass: unknown) => void) => {
        const draws: unknown[] = [];
        passes.push({ ...descriptor, draws });
        body({ draw: (drawable: unknown) => draws.push(drawable) });
      },
    }),
  );
  const gpu = {
    gpu: { queue: { onSubmittedWorkDone: vi.fn(async () => {}) } },
    settled: vi.fn(async () => {}),
    dispose: vi.fn(),
    clock: { advance: vi.fn() },
    fns: {
      surface: vi.fn(() => surface),
      target: vi.fn((opts: { size: readonly [number, number] }) => ({
        size: opts.size,
        texelSize: [1 / opts.size[0], 1 / opts.size[1]] as const,
        resize: vi.fn(),
      })),
      storage: vi.fn((bytes: number) => {
        const buffer = { size: bytes, write: vi.fn() };
        storages.push(buffer);
        return buffer;
      }),
      compute: vi.fn((_source: string, opts: Parameters<typeof make>[0]) => make(opts)),
      draw: vi.fn((opts: Parameters<typeof make>[0]) => make(opts)),
      effect: vi.fn((_source: string, opts: Parameters<typeof make>[0]) => make(opts)),
      sampler: vi.fn(() => ({})),
      frame,
    },
  };
  mocks.init.mockResolvedValueOnce(gpu);

  const byLabel = (suffix: string) => {
    const found = fakes.find((fake) => fake.label === `spring-choreography-${suffix}`);
    if (!found) throw new Error(`No GPU fake labelled ${suffix}`);
    return found;
  };
  return {
    canvas,
    container,
    containerListeners,
    windowListeners,
    media,
    compile,
    surface,
    unsubscribeResize,
    passes,
    dispatches,
    storages,
    frame,
    gpu,
    swarm: () => byLabel('swarm'),
    sparks: () => byLabel('sparks'),
    fade: () => byLabel('fade'),
    /** Floats of the per-frame state buffer (segments, then bursts) as last written. */
    stateFloats: () => storages[1]!.write.mock.calls.at(-1)![0] as Float32Array,
    tick(delta = 1000 / 60) {
      motion.frameData.delta = delta;
      const tick = motion.render.mock.calls.at(-1)?.[0] as (() => void) | undefined;
      tick?.();
    },
    play(seconds: number, delta = 50) {
      for (let elapsed = 0; elapsed < seconds * 1000; elapsed += delta) this.tick(delta);
    },
  };
}

function start(env: ReturnType<typeof setup>) {
  return createRenderer({ canvas: env.canvas, container: env.container as unknown as HTMLElement });
}

function timeline() {
  const current = motion.timelines.at(-1);
  if (!current) throw new Error('No timeline');
  return current.controls;
}

function pointer(env: ReturnType<typeof setup>, name: string, x: number, y: number, pointerType = 'mouse', target: unknown = env.canvas) {
  const listener = name === 'pointerup' ? env.windowListeners.get(name) : env.containerListeners.get(name);
  listener?.({ target, clientX: x, clientY: y, pointerType });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  mocks.init.mockReset();
  motion.frameData.delta = 1000 / 60;
  motion.values.length = 0;
  motion.timelines.length = 0;
  motion.tweens.length = 0;
  guiHarness.instances.length = 0;
});

test('renders from Motion’s render step with Motion’s delta', async () => {
  const env = setup();
  const renderer = start(env);
  await renderer.ready;

  // Storage buffers in the vertex stage need the limit; the thumbnail asks for it in meta.thumb.
  expect(mocks.init).toHaveBeenCalledWith({ requiredLimits: { maxStorageBuffersInVertexStage: 1 } });
  expect(env.gpu.fns.surface).toHaveBeenCalledWith(env.canvas, { dpr: [1, 2] });
  // swarm, sparks, fade, bright, four blurs and the composite (against the surface format).
  expect(env.compile).toHaveBeenCalledTimes(9);
  expect(env.compile).toHaveBeenCalledWith({ colors: ['rgba8unorm'] });
  expect(motion.render).toHaveBeenCalledOnce();
  expect(motion.render).toHaveBeenCalledWith(expect.any(Function), true);
  expect(motion.animate).toHaveBeenCalledWith(expect.any(Array), { repeat: Infinity });
  expect(env.frame).not.toHaveBeenCalled();

  env.tick(20);
  expect(env.gpu.clock.advance).toHaveBeenCalledWith(0.02);
  expect(env.frame).toHaveBeenCalledOnce();
  expect(env.dispatches).toEqual([[env.swarm(), DEFAULT_COUNT / 64]]);
  // scene → bright → four blurs → composite into the surface.
  expect(env.passes).toHaveLength(7);
  expect(env.passes[0]!.draws).toEqual([env.sparks()]);
  expect(env.passes.at(-1)?.target).toBe(env.surface);

  // A long stall (a background tab) advances the clock by at most 50 ms.
  env.tick(500);
  expect(env.gpu.clock.advance).toHaveBeenLastCalledWith(0.05);
  renderer.dispose();
});

test('every frame is a function of the playhead Motion’s timeline writes', async () => {
  const env = setup();
  const renderer = start(env);
  await renderer.ready;

  // Mid-morph from the knot into the galaxy: the segment is in the state buffer.
  timeline().time = 11.1;
  env.tick();
  const params = merged(env.swarm()).params;
  expect(params).toMatchObject({ time: expect.closeTo(11.1, 9), activeCount: 1, baseShape: 2, count: DEFAULT_COUNT });
  expect(params.springDuration).toBeCloseTo(bakeSpring(DEFAULT_SPRING).duration, 6);
  const state = env.stateFloats();
  expect(new Uint32Array(state.buffer, 0, 2)).toEqual(new Uint32Array([2, 3]));
  expect(state[4]).toBeCloseTo(11.1 - arrivalCue(3), 5);

  // The panel shows the playhead and the shape a few times a second, not every frame.
  const gui = guiHarness.instances[0]!;
  expect(gui.control('Time').updateDisplay).not.toHaveBeenCalled();
  env.play(0.25);
  expect(gui.control('Time').model.time).toBe(11.1);
  expect(gui.control('Time').updateDisplay).toHaveBeenCalled();
  expect(gui.control('Jump to').model.shape).toBe(3);

  // The playhead wraps with the looping timeline.
  timeline().time = LOOP + 1;
  env.tick();
  expect(merged(env.swarm()).params.time).toBeCloseTo(1, 9);
  renderer.dispose();
});

test('timelineSequence labels one linear playhead segment per shape', () => {
  const playhead = { get: () => 0 } as never;
  const sequence = timelineSequence(playhead) as unknown[];
  expect(sequence).toHaveLength(SHAPES.length * 2);
  SHAPES.forEach((shape, k) => {
    expect(sequence[k * 2]).toBe(shape.id);
    expect(sequence[k * 2 + 1]).toEqual([playhead, [k * SEGMENT, (k + 1) * SEGMENT], { duration: SEGMENT, ease: 'linear' }]);
  });
});

test('jumpDelta takes the shorter way round the loop', () => {
  expect(jumpDelta(1, 3)).toBeCloseTo(2, 9);
  expect(jumpDelta(3, 1)).toBeCloseTo(-2, 9);
  expect(jumpDelta(LOOP - 1, 1)).toBeCloseTo(2, 9);
  expect(jumpDelta(1, LOOP - 1)).toBeCloseTo(-2, 9);
});

describe('the lil-gui panel', () => {
  test('sits in the container and starts closed on narrow ones', async () => {
    const env = setup({ width: 640 });
    const renderer = start(env);
    await renderer.ready;
    const gui = guiHarness.instances[0]!;
    expect(gui.options).toMatchObject({ container: env.container, title: 'Spring Choreography' });
    expect(gui.domElement.style).toMatchObject({ position: 'absolute', top: '16px', right: '16px' });
    expect(gui.folders.map((folder) => folder.options.title)).toEqual(['Timeline', 'Spring', 'Stagger', 'Look']);
    expect(gui.close).toHaveBeenCalledOnce();
    expect(gui.folders[2]!.close).toHaveBeenCalledOnce();
    expect(gui.folders[3]!.close).toHaveBeenCalledOnce();
    renderer.dispose();

    const wide = setup({ width: 1280 });
    const second = start(wide);
    await second.ready;
    expect(guiHarness.instances[1]!.close).not.toHaveBeenCalled();
    second.dispose();
  });

  test('plays, pauses, scrubs and changes speed through the timeline controls', async () => {
    const env = setup();
    const renderer = start(env);
    await renderer.ready;
    const gui = guiHarness.instances[0]!;
    const controls = timeline();
    const button = gui.control('Pause');

    gui.press('Pause');
    expect(controls.pause).toHaveBeenCalledOnce();
    expect(button.label).toBe('Play');
    gui.press('Play');
    expect(controls.play).toHaveBeenCalledOnce();
    expect(button.label).toBe('Pause');

    // Scrubbing holds a playing timeline and lets go when the drag ends.
    gui.set('Time', 6);
    gui.set('Time', 7.5);
    expect(controls.pause).toHaveBeenCalledTimes(2);
    expect(controls.time).toBe(7.5);
    env.tick();
    expect(merged(env.swarm()).params.time).toBe(7.5);
    gui.finish('Time');
    expect(controls.play).toHaveBeenCalledTimes(2);

    // A paused timeline stays paused after a scrub.
    gui.press('Pause');
    gui.set('Time', 2);
    gui.finish('Time');
    expect(controls.play).toHaveBeenCalledTimes(2);

    gui.set('Speed', 2);
    expect(controls.speed).toBe(2);
    renderer.dispose();
  });

  test('Jump to fast-forwards the timeline itself the short way round', async () => {
    const env = setup();
    const renderer = start(env);
    await renderer.ready;
    const gui = guiHarness.instances[0]!;
    const controls = timeline();
    controls.time = 1;

    gui.set('Jump to', 3);
    expect(controls.pause).toHaveBeenCalledOnce();
    const tween = motion.tweens.at(-1)!;
    // Playing, it lands on the galaxy's cue and the morph plays out live.
    expect(tween.from).toBe(1);
    expect(tween.to).toBeCloseTo(arrivalCue(3), 9);
    tween.options.onUpdate(5);
    expect(controls.time).toBe(5);
    tween.options.onComplete();
    expect(controls.play).toHaveBeenCalledOnce();

    // From late in the loop the first shape is ahead, not behind.
    controls.time = LOOP - 1;
    gui.set('Jump to', 1);
    expect(motion.tweens.at(-1)!.to).toBeCloseTo(LOOP - 1 + jumpDelta(LOOP - 1, arrivalCue(1)), 9);
    expect(motion.tweens.at(-1)!.to).toBeGreaterThan(LOOP);

    // Paused, it lands where the shape has formed, and a new jump stops the old tween.
    const running = motion.tweens.at(-1)!;
    gui.press('Pause');
    expect(running.stop).toHaveBeenCalled();
    controls.time = 1;
    gui.set('Jump to', 3);
    expect(motion.tweens.at(-1)!.to).toBeGreaterThan(arrivalCue(3) + DEFAULT_STAGGER.spread);
    motion.tweens.at(-1)!.options.onComplete();
    expect(controls.play).toHaveBeenCalledOnce();
    renderer.dispose();
  });

  test('Jump to from the start of the timeline rewinds into the previous loop', async () => {
    const env = setup();
    const renderer = start(env);
    await renderer.ready;
    const controls = timeline();
    controls.time = 1.45;

    // The triangle's cue is 5 s back, before the timeline's 0: start one loop later instead.
    guiHarness.instances[0]!.set('Jump to', 0);
    const tween = motion.tweens.at(-1)!;
    expect(tween.from).toBeCloseTo(1.45 + LOOP, 9);
    expect(tween.to).toBeCloseTo(arrivalCue(0), 9);
    expect(tween.to - tween.from).toBeCloseTo(jumpDelta(1.45, arrivalCue(0)), 9);
    renderer.dispose();
  });

  test('Replay morph rewinds to the latest cue and plays it', async () => {
    const env = setup();
    const renderer = start(env);
    await renderer.ready;
    const gui = guiHarness.instances[0]!;
    const controls = timeline();

    gui.press('Pause');
    controls.time = 11.1;
    gui.press('Replay morph');
    expect(controls.play).toHaveBeenCalledOnce();
    expect(gui.control('Pause').label).toBe('Pause');
    // Playing again, it lands on the cue itself and the morph into the galaxy plays out.
    const tween = motion.tweens.at(-1)!;
    expect(tween.from).toBe(11.1);
    expect(tween.to).toBeCloseTo(arrivalCue(3), 9);
    renderer.dispose();
  });

  test('spring settings rebake Motion’s spring into the GPU table live', async () => {
    const env = setup();
    const renderer = start(env);
    await renderer.ready;
    const gui = guiHarness.instances[0]!;
    const tables = env.storages[0]!;

    gui.set('Preset', 'Snappy');
    expect(gui.control('Stiffness').model).toMatchObject(SPRING_PRESETS.Snappy);
    expect(gui.control('Stiffness').updateDisplay).toHaveBeenCalled();
    const snappy = bakeSpring(SPRING_PRESETS.Snappy);
    const written = tables.write.mock.calls.at(-1)![0] as Float32Array;
    expect(written.subarray(0, SPRING_SAMPLES * 2)).toEqual(snappy.values);
    expect(merged(env.swarm()).params.springDuration).toBeCloseTo(snappy.duration, 6);

    // Touching a slider makes it a custom spring.
    gui.set('Damping', 12);
    expect(gui.control('Preset').model.preset).toBe('Custom');
    expect(gui.control('Preset').updateDisplay).toHaveBeenCalled();
    const custom = bakeSpring({ ...SPRING_PRESETS.Snappy, damping: 12 });
    expect(merged(env.swarm()).params.springDuration).toBeCloseTo(custom.duration, 6);

    gui.set('Spread (s)', 2);
    expect(merged(env.swarm()).params.spread).toBe(2);
    renderer.dispose();
  });

  test('the particle count swaps buffers and reuses one it already made', async () => {
    const env = setup();
    const renderer = start(env);
    await renderer.ready;
    const gui = guiHarness.instances[0]!;
    const initial = merged(env.swarm()).particles;
    expect(initial.size).toBe(DEFAULT_COUNT * 32);

    gui.set('Particles', PARTICLE_COUNTS['1M']);
    const large = merged(env.swarm()).particles;
    expect(large.size).toBe(PARTICLE_COUNTS['1M'] * 32);
    expect(merged(env.sparks()).particles).toBe(large);
    env.tick();
    expect(env.dispatches.at(-1)).toEqual([env.swarm(), PARTICLE_COUNTS['1M'] / 64]);
    // Four times the sparks, each dimmer.
    const energies = env.swarm().set.mock.calls.map(([values]) => values.params?.energy).filter(Boolean);
    expect(energies.at(-1)).toBeLessThan(energies.at(-2));

    const buffers = env.storages.length;
    gui.set('Particles', DEFAULT_COUNT);
    expect(merged(env.swarm()).particles).toBe(initial);
    expect(env.storages).toHaveLength(buffers);
    renderer.dispose();
  });
});

describe('the pointer', () => {
  test('a mouse over the canvas pushes the swarm, and leaving lets it spring back', async () => {
    const env = setup();
    const renderer = start(env);
    await renderer.ready;

    pointer(env, 'pointermove', 480, 90);
    env.tick();
    const params = merged(env.swarm()).params;
    expect(params.pointer).toEqual([0.5, 0.5]);
    expect(params.pointerStrength).toBe(1);
    // CSS px scaled to device pixels.
    expect(params.pointerRadius).toBeCloseTo(360 * 0.17 * 2, 6);

    // The panel sits over the canvas; moving onto it releases the swarm where the pointer left it.
    pointer(env, 'pointermove', 100, 300, 'mouse', { tagName: 'BUTTON' });
    env.tick();
    expect(merged(env.swarm()).params.pointer).toEqual([0.5, 0.5]);
    expect(merged(env.swarm()).params.pointerStrength).toBe(0);
    pointer(env, 'pointermove', 160, 90);
    env.tick();
    expect(merged(env.swarm()).params).toMatchObject({ pointer: [-0.5, 0.5], pointerStrength: 1 });

    env.containerListeners.get('pointerleave')?.({ pointerType: 'mouse' });
    env.tick();
    expect(merged(env.swarm()).params.pointerStrength).toBe(0);
    renderer.dispose();
  });

  test('the push radius follows the viewport within cursor and finger sizes', async () => {
    const env = setup();
    const renderer = start(env);
    await renderer.ready;
    const resize = env.surface.onResize.mock.calls[0]![0];
    const radiusAt = (width: number, height: number, dpr: number) => {
      resize({ width, height, dpr });
      env.tick();
      // Device pixels: CSS pixels times the pixel ratio.
      return merged(env.swarm()).params.pointerRadius / dpr;
    };
    expect(radiusAt(1664, 936, 2)).toBeCloseTo(468 * 0.17, 6);
    expect(radiusAt(390, 300, 1)).toBe(56);
    expect(radiusAt(5120, 2880, 2)).toBe(150);
    renderer.dispose();
  });

  test('a tap bursts a re-stagger from where it landed; a drag does not', async () => {
    const env = setup();
    const renderer = start(env);
    await renderer.ready;
    const burstAt = MAX_ACTIVE * 8;

    pointer(env, 'pointerdown', 160, 270, 'touch');
    env.tick();
    expect(merged(env.swarm()).params.pointerStrength).toBe(1);
    pointer(env, 'pointerup', 162, 271, 'touch');
    env.tick();
    const state = env.stateFloats();
    expect(state[burstAt]).toBeCloseTo(162 / 320 - 1, 6);
    expect(state[burstAt + 1]).toBeCloseTo(1 - 271 / 180, 6);
    expect(state[burstAt + 3]).toBeGreaterThan(0);
    // A lifted finger stops pushing.
    expect(merged(env.swarm()).params.pointerStrength).toBe(0);

    // The burst ages with the wall clock and retires once its springs have settled.
    env.play(0.5);
    expect(env.stateFloats()[burstAt + 2]).toBeCloseTo(0.5 + 1 / 60, 5);
    env.play(6);
    expect(env.stateFloats()[burstAt + 3]).toBe(0);

    pointer(env, 'pointerdown', 100, 100, 'touch');
    pointer(env, 'pointermove', 200, 120, 'touch');
    pointer(env, 'pointerup', 200, 120, 'touch');
    env.tick();
    expect(env.stateFloats()[burstAt + 3]).toBe(0);

    // The panel's button bursts from the centre.
    guiHarness.instances[0]!.press('Burst from centre');
    env.tick();
    expect(Array.from(env.stateFloats().subarray(burstAt, burstAt + 2))).toEqual([0, 0]);
    expect(env.stateFloats()[burstAt + 3]).toBeGreaterThan(0);
    renderer.dispose();
  });
});

test('trails fade the previous frame at constant brightness, and a scrub cuts them', async () => {
  const env = setup();
  const renderer = start(env);
  await renderer.ready;
  guiHarness.instances[0]!.set('Trails', true);

  // The first frame after a resize has no previous frame to fade.
  env.tick();
  expect(env.passes.at(0)).toMatchObject({ clear: [0, 0, 0, 1] });

  env.passes.length = 0;
  env.tick(1000 / 60);
  const keep = merged(env.fade()).fade.keep;
  expect(keep).toBeCloseTo(0.8, 6);
  expect(env.passes[0]).toMatchObject({ clear: false, draws: [env.fade(), env.sparks()] });
  // Sparks give up what the fade keeps, so a still swarm is as bright as without trails.
  expect(merged(env.sparks()).view.gain).toBeCloseTo(1 - keep, 6);

  // A jump across the timeline starts a clean frame instead of ghosting the old shape.
  env.passes.length = 0;
  timeline().time = 12;
  env.tick();
  expect(env.passes[0]).toMatchObject({ clear: [0, 0, 0, 1], draws: [env.sparks()] });
  expect(merged(env.sparks()).view.gain).toBe(1);

  // So does a Jump to, for as long as it fast-forwards.
  env.tick();
  expect(merged(env.fade()).fade.keep).toBeCloseTo(0.8, 6);
  guiHarness.instances[0]!.set('Jump to', 0);
  env.passes.length = 0;
  env.play(0.2);
  expect(env.passes.filter((pass) => pass.target === env.passes[0]!.target).every((pass) => pass.clear !== false)).toBe(true);
  motion.tweens.at(-1)!.options.onComplete();
  env.tick();
  expect(merged(env.fade()).fade.keep).toBeCloseTo(0.8, 6);
  renderer.dispose();
});

test('reduced motion keeps the choreography but calms it, and follows a change mid-session', async () => {
  const env = setup({ reducedMotion: true });
  const renderer = start(env);
  await renderer.ready;
  const gui = guiHarness.instances[0]!;
  const calm = gui.control('Calm motion');
  expect(calm.model.calm).toBe(true);
  // Slower, critically damped, no streaks.
  expect(timeline().speed).toBeCloseTo(0.6, 9);
  const params = merged(env.swarm()).params;
  expect(params.springDuration).toBeCloseTo(bakeSpring(criticallyDamped(DEFAULT_SPRING)).duration, 6);
  expect(params.streak).toBe(0);
  gui.set('Trails', true);
  env.play(0.2);
  expect(env.passes.at(-7)).toMatchObject({ clear: [0, 0, 0, 1] });
  pointer(env, 'pointermove', 320, 180);
  env.tick();
  expect(merged(env.swarm()).params.pointerStrength).toBeCloseTo(0.4, 9);

  const onChange = env.media.addEventListener.mock.calls[0]![1] as () => void;
  env.media.matches = false;
  onChange();
  expect(calm.model.calm).toBe(false);
  expect(calm.updateDisplay).toHaveBeenCalledOnce();
  expect(timeline().speed).toBe(1);
  expect(merged(env.swarm()).params.springDuration).toBeCloseTo(bakeSpring(DEFAULT_SPRING).duration, 6);
  renderer.dispose();
});

test('a frame that throws stops the renderer once and reports the error', async () => {
  const env = setup();
  const renderer = start(env);
  await renderer.ready;
  const tick = motion.render.mock.calls[0]![0];
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
  renderer.dispose();
  expect(env.gpu.dispose).toHaveBeenCalledOnce();
});

test('dispose is idempotent and releases Motion, listeners and the GUI', async () => {
  const env = setup();
  const renderer = start(env);
  await renderer.ready;
  const tick = motion.render.mock.calls[0]![0];
  expect(env.containerListeners.size).toBe(3);
  expect(env.windowListeners.size).toBe(2);
  expect(env.media.addEventListener).toHaveBeenCalledWith('change', expect.any(Function));
  guiHarness.instances[0]!.set('Jump to', 2);
  const tween = motion.tweens.at(-1)!;

  renderer.dispose();
  renderer.dispose();
  expect(motion.cancelFrame).toHaveBeenCalledOnce();
  expect(motion.cancelFrame).toHaveBeenCalledWith(tick);
  expect(timeline().stop).toHaveBeenCalledOnce();
  expect(tween.stop).toHaveBeenCalledOnce();
  expect(motion.values).toHaveLength(7);
  for (const value of motion.values) expect(value.destroy).toHaveBeenCalledOnce();
  expect(env.unsubscribeResize).toHaveBeenCalledOnce();
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
  expect(motion.render).not.toHaveBeenCalled();
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
  expect(motion.timelines).toHaveLength(0);
  expect(motion.render).not.toHaveBeenCalled();
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
  expect(motion.render).not.toHaveBeenCalled();
});

test('a missing GUI container fails initialization and tears down', async () => {
  const env = setup();
  (env.canvas as unknown as { parentElement: unknown }).parentElement = null;
  const renderer = createRenderer({ canvas: env.canvas });
  await expect(renderer.ready).rejects.toThrow('needs a GUI container');
  expect(env.gpu.dispose).toHaveBeenCalledOnce();
  expect(env.windowListeners.size).toBe(0);
  expect(motion.render).not.toHaveBeenCalled();
});

test('the thumbnail renders the timeline at its time and waits for both GPU drains', async () => {
  const env = setup();
  const drained = deferred<void>();
  const settled = deferred<void>();
  env.gpu.gpu.queue.onSubmittedWorkDone = vi.fn(() => drained.promise);
  env.gpu.settled = vi.fn(() => settled.promise);
  const output = { size: [320, 180] as const, format: 'rgba8unorm' };

  let done = false;
  const run = renderThumbnail(env.gpu as never, output as never, { warmupFrames: 3, time: 11.1 }).then(() => {
    done = true;
  });
  await vi.waitFor(() => expect(env.gpu.settled).toHaveBeenCalledOnce());
  expect(env.frame).toHaveBeenCalledTimes(3);
  expect(env.passes.at(-1)?.target).toBe(output);
  expect(env.compile).toHaveBeenCalledWith({ colors: ['rgba8unorm'] });
  const params = merged(env.swarm()).params;
  expect(params).toMatchObject({ time: 11.1, resolution: [320, 180], pixelRatio: 1, pointerStrength: 0 });
  // No trails: every frame clears.
  expect(env.passes.filter((pass) => pass.clear === false)).toHaveLength(0);
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
