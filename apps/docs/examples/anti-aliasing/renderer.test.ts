import { afterEach, expect, test, vi } from 'vitest';

const guiMocks = vi.hoisted(() => ({
  change: undefined as ((mode: number) => void) | undefined,
  destroy: vi.fn(),
}));
const mocks = vi.hoisted(() => ({ init: vi.fn() }));
const vgpuFns = vi.hoisted(() =>
  Object.fromEntries(
    ['surface', 'target', 'effect', 'draw', 'geometry', 'frame', 'frameLoop'].map((name) => [
      name,
      (gpu: any, ...args: any[]) => gpu.fns[name](...args),
    ]),
  ),
);

vi.mock('vgpu', () => ({
  init: mocks.init,
  ...vgpuFns,
  clock: (gpu: any) => gpu.clock ?? { time: 0 },
}));
vi.mock('lil-gui', () => ({
  default: class MockGui {
    domElement = { style: {} };
    destroy = guiMocks.destroy;

    add() {
      return {
        name() {
          return this;
        },
        onChange(change: (mode: number) => void) {
          guiMocks.change = change;
          return this;
        },
      };
    }
  },
}));

import { renderThumbnail } from './render-thumbnail';
import { createRenderer } from './renderer';
import { MODES } from './scene';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function setup(options: { compile?: () => Promise<void> } = {}) {
  let resizeFrame: FrameRequestCallback | undefined;
  vi.stubGlobal('window', {
    devicePixelRatio: 1,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn((callback: FrameRequestCallback) => {
      resizeFrame = callback;
      return 1;
    }),
  );
  vi.stubGlobal('cancelAnimationFrame', vi.fn(() => (resizeFrame = undefined)));
  const disconnect = vi.fn();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe = vi.fn();
      disconnect = disconnect;
    },
  );

  const canvas = {
    parentElement: {} as HTMLElement,
    getBoundingClientRect: () => ({ width: 100, height: 50 }),
  } as HTMLCanvasElement;
  const surface = { size: [80, 40], format: 'bgra8unorm', dispose: vi.fn() };
  const mesh = { destroy: vi.fn() };
  const programs: any[] = [];
  const targets: any[] = [];
  const makeProgram = () => {
    const program = {
      set: vi.fn(),
      compile: vi.fn(() => options.compile?.() ?? Promise.resolve()),
    };
    programs.push(program);
    return program;
  };
  const makeTarget = ({ size }: { size: readonly [number, number] }) => {
    const colorTarget = {
      size: [...size],
      format: 'rgba8unorm',
      resize: vi.fn((next: readonly [number, number]) => (colorTarget.size = [...next])),
      destroy: vi.fn(),
    };
    targets.push(colorTarget);
    return colorTarget;
  };

  let render: ((frame: unknown) => void) | undefined;
  const stop = vi.fn();
  const submitted = vi.fn(async () => {});
  const gpu = {
    gpu: { queue: { onSubmittedWorkDone: submitted } },
    clock: { time: 1.2 },
    settled: vi.fn(async () => {}),
    dispose: vi.fn(),
    fns: {
      surface: vi.fn(() => surface),
      geometry: vi.fn(() => mesh),
      draw: vi.fn(makeProgram),
      effect: vi.fn(makeProgram),
      target: vi.fn(makeTarget),
      frameLoop: vi.fn((callback: (frame: unknown) => void) => {
        render = callback;
        return { stop };
      }),
    },
  };
  mocks.init.mockResolvedValueOnce(gpu);

  const flushResize = () => {
    if (!resizeFrame) throw new Error('No resize frame is pending.');
    const callback = resizeFrame;
    resizeFrame = undefined;
    callback(0);
  };
  const runFrame = () => {
    const drawCall = vi.fn();
    const pass = vi.fn((_options, encode) => encode({ draw: drawCall }));
    render?.({ pass });
    return { drawCall, pass };
  };

  return {
    canvas,
    disconnect,
    flushResize,
    gpu,
    mesh,
    programs,
    runFrame,
    stop,
    submitted,
    surface,
    targets,
  };
}

function expectSceneReleased(env: ReturnType<typeof setup>) {
  expect(env.mesh.destroy).toHaveBeenCalledOnce();
  for (const target of env.targets) expect(target.destroy).toHaveBeenCalledOnce();
}

function expectGpuTeardownDelegated(env: ReturnType<typeof setup>) {
  expect(env.gpu.dispose).toHaveBeenCalledOnce();
  expect(env.stop).not.toHaveBeenCalled();
  expect(env.surface.dispose).not.toHaveBeenCalled();
  expect(env.mesh.destroy).not.toHaveBeenCalled();
  for (const target of env.targets) expect(target.destroy).not.toHaveBeenCalled();
}

afterEach(() => {
  guiMocks.change = undefined;
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

test('renders GUI changes, resizes once, and delegates VGPU teardown', async () => {
  const env = setup();
  const renderer = createRenderer({ canvas: env.canvas });
  await renderer.ready;

  env.flushResize();
  expect(env.targets.map(({ size }) => size)).toEqual([
    [100, 50],
    [200, 100],
    [100, 50],
  ]);
  const resolutionCalls = env.programs[0].set.mock.calls
    .map((call: [{ logical_resolution?: unknown }]) => call[0].logical_resolution)
    .filter(Boolean);
  expect(resolutionCalls).toEqual([
    [80, 40],
    [100, 50],
  ]);

  expect(guiMocks.change).toBeTypeOf('function');
  guiMocks.change!(MODES.Off);
  const frame = env.runFrame();
  expect(frame.pass).toHaveBeenCalledOnce();
  expect(frame.pass.mock.calls[0][0].target).toBe(env.surface);
  expect(frame.drawCall).toHaveBeenCalledWith(env.programs[0]);

  renderer.dispose();
  renderer.dispose();
  expect(guiMocks.destroy).toHaveBeenCalledOnce();
  expect(env.disconnect).toHaveBeenCalledOnce();
  expectGpuTeardownDelegated(env);
});

test('disposes a GPU that resolves after initialization was cancelled', async () => {
  const env = setup();
  const pendingInit = deferred<typeof env.gpu>();
  mocks.init.mockReset().mockReturnValueOnce(pendingInit.promise);
  const renderer = createRenderer({ canvas: env.canvas });
  await vi.waitFor(() => expect(mocks.init).toHaveBeenCalledOnce());

  renderer.dispose();
  pendingInit.resolve(env.gpu);
  await renderer.ready;

  expect(env.gpu.dispose).toHaveBeenCalledOnce();
  expect(env.gpu.fns.surface).not.toHaveBeenCalled();
});

test('disposal during prewarm releases resources and prevents a late mount', async () => {
  const pendingCompile = deferred<void>();
  const env = setup({ compile: () => pendingCompile.promise });
  const renderer = createRenderer({ canvas: env.canvas });
  await vi.waitFor(() => expect(env.programs[0]?.compile).toHaveBeenCalled());

  renderer.dispose();
  pendingCompile.resolve();
  await renderer.ready;

  expect(guiMocks.change).toBeUndefined();
  expect(env.gpu.fns.frameLoop).not.toHaveBeenCalled();
  expectGpuTeardownDelegated(env);
});

test('resize failure tears down before surfacing', async () => {
  const env = setup();
  const renderer = createRenderer({ canvas: env.canvas });
  await renderer.ready;
  env.targets[0].resize.mockImplementationOnce(() => {
    throw new Error('resize failed');
  });

  expect(env.flushResize).toThrow('resize failed');
  expectGpuTeardownDelegated(env);
});

test('thumbnail cleanup survives synchronous drain failures', async () => {
  const compileFailure = new Error('compile failed');
  const env = setup({ compile: () => Promise.reject(compileFailure) });
  env.submitted.mockImplementation(() => {
    throw new Error('queue drain failed');
  });
  env.gpu.settled.mockImplementation(() => {
    throw new Error('gpu settle failed');
  });

  await expect(renderThumbnail(env.gpu as never, env.surface as never)).rejects.toBe(compileFailure);
  expect(env.submitted).toHaveBeenCalledOnce();
  expect(env.gpu.settled).toHaveBeenCalledOnce();
  expectSceneReleased(env);
});
