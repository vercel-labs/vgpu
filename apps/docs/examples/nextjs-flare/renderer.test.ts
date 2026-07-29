import { afterEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ init: vi.fn() }));
vi.mock('vgpu', () => ({
  init: mocks.init,
  surface: (gpu: any, canvas: any, options: any) => gpu.surface(canvas, options),
  sampler: (gpu: any, options: any) => gpu.sampler(options),
  effect: (gpu: any, shader: any, options: any) => gpu.effect(shader, options),
  target: (gpu: any, options: any) => gpu.target(options),
  frame: (gpu: any, callback: any) => gpu.frame(callback),
}));
vi.mock('./logo-raster', () => ({
  rasterizeLogo: vi.fn(async () => ({ width: 130, height: 156 })),
}));

import { createRenderer, renderThumbnail } from './renderer';

function setup(options: { failCompile?: boolean } = {}) {
  const canvasListeners = new Map<string, EventListener>();
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  vi.stubGlobal('window', { devicePixelRatio: 2 });
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn((callback: FrameRequestCallback) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    }),
  );
  const cancelFrame = vi.fn((id: number) => frames.delete(id));
  vi.stubGlobal('cancelAnimationFrame', cancelFrame);
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
    addEventListener: vi.fn((name: string, listener: EventListener) =>
      canvasListeners.set(name, listener),
    ),
    removeEventListener: vi.fn((name: string) => canvasListeners.delete(name)),
  } as unknown as HTMLCanvasElement;

  const compile = options.failCompile
    ? vi.fn(async () => {
        throw new Error('compile failed');
      })
    : vi.fn(async () => {});
  const textures: Array<{ destroy: ReturnType<typeof vi.fn> }> = [];
  const targets: Array<{ color: { destroy: ReturnType<typeof vi.fn> } }> = [];
  const surface = {
    resize: vi.fn(),
    dispose: vi.fn(),
    format: 'bgra8unorm',
    sampleCount: 1,
  };
  const framePass = vi.fn();
  const gpu = {
    gpu: {
      createTexture: vi.fn(() => {
        const texture = { destroy: vi.fn() };
        textures.push(texture);
        return texture;
      }),
      queue: {
        writeTexture: vi.fn(),
        copyExternalImageToTexture: vi.fn(),
        onSubmittedWorkDone: vi.fn(async () => {}),
      },
    },
    sampler: vi.fn(() => ({})),
    effect: vi.fn(() => ({ set: vi.fn(), compile })),
    target: vi.fn(() => {
      const target = {
        size: [160, 90],
        resize: vi.fn(),
        color: { destroy: vi.fn() },
        format: 'rgba8unorm',
        sampleCount: 1,
      };
      targets.push(target);
      return target;
    }),
    surface: vi.fn(() => surface),
    frame: vi.fn((callback: (frame: { pass: typeof framePass }) => void) =>
      callback({ pass: framePass }),
    ),
    settled: vi.fn(async () => {}),
    dispose: vi.fn(),
  };
  mocks.init.mockResolvedValueOnce(gpu);
  return {
    canvas,
    canvasListeners,
    frames,
    cancelFrame,
    disconnect,
    textures,
    targets,
    surface,
    framePass,
    gpu,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

test('renders the multi-pass chain and tears everything down on dispose', async () => {
  const env = setup();
  const renderer = createRenderer({ canvas: env.canvas });
  await renderer.ready;
  // Blue-noise + logo textures, four intermediate targets, pointer steering.
  expect(env.textures).toHaveLength(2);
  expect(env.targets).toHaveLength(4);
  expect(env.canvasListeners.has('pointermove')).toBe(true);

  // First animation frame draws all five passes (static logo pass included).
  [...env.frames.values()][0]?.(100);
  expect(env.gpu.frame).toHaveBeenCalledOnce();
  expect(env.framePass).toHaveBeenCalledTimes(5);

  renderer.dispose();
  renderer.dispose();
  expect(env.cancelFrame).toHaveBeenCalledOnce();
  expect(env.disconnect).toHaveBeenCalledOnce();
  expect(env.canvasListeners.size).toBe(0);
  for (const texture of env.textures) expect(texture.destroy).toHaveBeenCalledOnce();
  for (const target of env.targets) expect(target.color.destroy).toHaveBeenCalledOnce();
  expect(env.surface.dispose).toHaveBeenCalledOnce();
  expect(env.gpu.dispose).toHaveBeenCalledOnce();
});

test('coalesces resizes into fresh targets without leaking the old ones', async () => {
  const env = setup();
  const renderer = createRenderer({ canvas: env.canvas });
  await renderer.ready;
  expect(env.targets).toHaveLength(4);

  renderer.resize({ width: 300, height: 150, dpr: 1.6 });
  renderer.resize({ width: 400, height: 200, dpr: 1.6 });
  await renderer.ready;
  await vi.waitFor(() => expect(env.targets.length).toBeGreaterThan(4));
  await vi.waitFor(() => {
    for (const target of env.targets.slice(0, 4)) {
      expect(target.color.destroy).toHaveBeenCalledOnce();
    }
  });
  renderer.dispose();
});

test('thumbnail destroys its pipeline when prewarm fails', async () => {
  const env = setup();
  const failingCompile = vi.fn(async () => {
    throw new Error('compile failed');
  });
  env.gpu.effect.mockImplementation(() => ({ set: vi.fn(), compile: failingCompile }));
  const output = {
    size: [160, 90],
    resize: vi.fn(),
    format: 'rgba8unorm',
    sampleCount: 1,
  };
  await expect(renderThumbnail(env.gpu as never, output as never)).rejects.toThrow(
    'compile failed',
  );
  expect(env.targets).toHaveLength(4);
  for (const target of env.targets) expect(target.color.destroy).toHaveBeenCalledOnce();
  // The blue-noise texture created for the thumbnail pipeline is released.
  expect(env.textures).toHaveLength(1);
  for (const texture of env.textures) expect(texture.destroy).toHaveBeenCalledOnce();
});
