import { afterEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ init: vi.fn(), loadVideo: vi.fn() }));
const sceneFns = vi.hoisted(() => ({
  createScene: vi.fn(),
  destroyScene: vi.fn(),
  renderScene: vi.fn(),
  uploadFrame: vi.fn(),
  uploadTestPattern: vi.fn(),
}));
const vgpuFns = vi.hoisted(() => ({
  clock: (gpu: any) => gpu.clock,
  frameLoop: (gpu: any, ...args: any[]) => gpu.fns.frameLoop(...args),
  surface: (gpu: any, ...args: any[]) => gpu.fns.surface(...args),
}));

vi.mock('vgpu', () => ({ init: mocks.init, ...vgpuFns }));
vi.mock('./scene', () => ({ ...sceneFns, FRAME_SIZE: { width: 640, height: 360 } }));
vi.mock('./video-source', () => ({ loadVideo: mocks.loadVideo }));

import { createRenderer } from './renderer';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function setup() {
  const canvas = {} as HTMLCanvasElement;
  const output = { size: [320, 180] };
  const scene = { cube: {}, width: 640, height: 360 };
  const video = {
    width: 640,
    height: 360,
    frame: {} as HTMLVideoElement,
    consume: vi.fn(() => true),
    dispose: vi.fn(),
  };
  const stop = vi.fn();
  let loopCallback: ((frame: unknown) => void) | undefined;
  const gpu = {
    clock: { time: 2.7 },
    dispose: vi.fn(),
    fns: {
      surface: vi.fn(() => output),
      frameLoop: vi.fn((callback: (frame: unknown) => void) => {
        loopCallback = callback;
        return { stop };
      }),
    },
  };
  mocks.init.mockResolvedValue(gpu);
  mocks.loadVideo.mockResolvedValue(video);
  sceneFns.createScene.mockReturnValue(scene);

  return {
    canvas,
    output,
    scene,
    video,
    stop,
    gpu,
    get loopCallback() {
      return loopCallback;
    },
  };
}

afterEach(() => vi.resetAllMocks());

test('uploads only fresh video frames and disposes every owned resource', async () => {
  const env = setup();
  const renderer = createRenderer(env.canvas);
  await renderer.ready;

  expect(mocks.loadVideo).toHaveBeenCalledWith(
    '/examples/video-to-texture/big-buck-bunny-360p-glide.mp4',
    30,
    expect.any(AbortSignal),
  );
  expect(env.gpu.fns.surface).toHaveBeenCalledWith(env.canvas, { dpr: [1, 2] });
  expect(sceneFns.createScene).toHaveBeenCalledWith(env.gpu, env.video);
  expect(sceneFns.uploadTestPattern).toHaveBeenCalledWith(env.gpu, env.scene);

  env.loopCallback?.({ id: 'frame' });
  expect(sceneFns.uploadFrame).toHaveBeenCalledWith(
    env.gpu,
    env.scene,
    env.video.frame,
  );
  expect(sceneFns.renderScene).toHaveBeenCalledWith(
    { id: 'frame' },
    env.scene,
    env.output,
    2.7,
  );

  renderer.dispose();
  renderer.dispose();
  expect(env.stop).toHaveBeenCalledOnce();
  expect(env.video.dispose).toHaveBeenCalledOnce();
  expect(sceneFns.destroyScene).toHaveBeenCalledOnce();
  expect(env.gpu.dispose).toHaveBeenCalledOnce();
});

test('quietly disposes a GPU that arrives after intentional cancellation', async () => {
  const env = setup();
  const initializing = deferred<typeof env.gpu>();
  mocks.init.mockReturnValueOnce(initializing.promise);
  const renderer = createRenderer(env.canvas);
  await vi.waitFor(() => expect(mocks.init).toHaveBeenCalledOnce());

  renderer.dispose();
  initializing.resolve(env.gpu);

  await expect(renderer.ready).resolves.toBeUndefined();
  expect(env.gpu.dispose).toHaveBeenCalledOnce();
  expect(mocks.loadVideo).not.toHaveBeenCalled();
});

test('aborts a pending video load on unmount', async () => {
  const env = setup();
  const loading = deferred<typeof env.video>();
  mocks.loadVideo.mockImplementationOnce((_url, _fps, signal: AbortSignal) => {
    signal.addEventListener('abort', () => loading.reject(signal.reason), { once: true });
    return loading.promise;
  });
  const renderer = createRenderer(env.canvas);
  await vi.waitFor(() => expect(mocks.loadVideo).toHaveBeenCalledOnce());
  const signal = mocks.loadVideo.mock.calls[0]?.[2] as AbortSignal;

  renderer.dispose();

  expect(signal.aborted).toBe(true);
  await expect(renderer.ready).resolves.toBeUndefined();
  expect(env.gpu.dispose).toHaveBeenCalledOnce();
  expect(env.gpu.fns.surface).not.toHaveBeenCalled();
});

test('cleans up video and GPU after setup fails', async () => {
  const env = setup();
  const failure = new Error('surface setup failed');
  env.gpu.fns.surface.mockImplementationOnce(() => {
    throw failure;
  });
  const renderer = createRenderer(env.canvas);

  await expect(renderer.ready).rejects.toBe(failure);
  expect(env.video.dispose).toHaveBeenCalledOnce();
  expect(env.gpu.dispose).toHaveBeenCalledOnce();
});

test('tears down and preserves a live upload failure', async () => {
  const env = setup();
  const renderer = createRenderer(env.canvas);
  await renderer.ready;
  const failure = new Error('video upload failed');
  sceneFns.uploadFrame.mockImplementationOnce(() => {
    throw failure;
  });

  expect(() => env.loopCallback?.({})).toThrow(failure);
  expect(env.stop).toHaveBeenCalledOnce();
  expect(env.video.dispose).toHaveBeenCalledOnce();
  expect(sceneFns.destroyScene).toHaveBeenCalledOnce();
  expect(env.gpu.dispose).toHaveBeenCalledOnce();
});

test('runs all cleanup while preserving the first disposal failure', async () => {
  const env = setup();
  const renderer = createRenderer(env.canvas);
  await renderer.ready;
  const failure = new Error('loop stop failed');
  env.stop.mockImplementationOnce(() => {
    throw failure;
  });
  env.video.dispose.mockImplementationOnce(() => {
    throw new Error('video cleanup failed');
  });

  expect(() => renderer.dispose()).toThrow(failure);
  expect(sceneFns.destroyScene).toHaveBeenCalledOnce();
  expect(env.gpu.dispose).toHaveBeenCalledOnce();
});
