import { afterEach, expect, test, vi } from 'vitest';

const vgpuFns = vi.hoisted(() => ({ frame: vi.fn() }));
const sceneFns = vi.hoisted(() => ({
  createScene: vi.fn(),
  destroyScene: vi.fn(),
  renderScene: vi.fn(),
  uploadTestPattern: vi.fn(),
}));

vi.mock('vgpu', () => vgpuFns);
vi.mock('./scene', () => ({
  ...sceneFns,
  FRAME_SIZE: { width: 640, height: 360 },
  SPIN_RATE: 0.15,
}));

import { renderThumbnail } from './render-thumbnail';

function setup() {
  const scene = { cube: {}, width: 640, height: 360 };
  const target = { size: [320, 180] };
  const queueDone = vi.fn(async () => undefined);
  const settled = vi.fn(async () => undefined);
  const gpu = { gpu: { queue: { onSubmittedWorkDone: queueDone } }, settled };
  sceneFns.createScene.mockReturnValue(scene);
  vgpuFns.frame.mockImplementation((_gpu, callback: (frame: unknown) => void) =>
    callback({ id: 'frame' }),
  );
  return { scene, target, gpu, queueDone, settled };
}

afterEach(() => vi.resetAllMocks());

test('uses the spin-independent default pose and honors an explicit zero time', async () => {
  const env = setup();
  await renderThumbnail(env.gpu as never, env.target as never);
  await renderThumbnail(env.gpu as never, env.target as never, { time: 0 });

  expect(sceneFns.renderScene).toHaveBeenNthCalledWith(
    1,
    { id: 'frame' },
    env.scene,
    env.target,
    2.7,
  );
  expect(sceneFns.renderScene).toHaveBeenNthCalledWith(
    2,
    { id: 'frame' },
    env.scene,
    env.target,
    0,
  );
});

test('waits for both GPU barriers before destroying the scene', async () => {
  const env = setup();
  let releaseQueue!: () => void;
  let releaseSettled!: () => void;
  env.queueDone.mockReturnValueOnce(new Promise<undefined>((resolve) => {
    releaseQueue = () => resolve(undefined);
  }));
  env.settled.mockReturnValueOnce(new Promise<undefined>((resolve) => {
    releaseSettled = () => resolve(undefined);
  }));

  const rendering = renderThumbnail(env.gpu as never, env.target as never);
  await vi.waitFor(() => {
    expect(env.queueDone).toHaveBeenCalledOnce();
    expect(env.settled).toHaveBeenCalledOnce();
  });
  expect(sceneFns.destroyScene).not.toHaveBeenCalled();

  releaseQueue();
  await Promise.resolve();
  expect(sceneFns.destroyScene).not.toHaveBeenCalled();

  releaseSettled();
  await rendering;

  expect(sceneFns.destroyScene).toHaveBeenCalledWith(env.scene);
});

test('surfaces a barrier failure after cleanup', async () => {
  const env = setup();
  const failure = new Error('queue failed');
  env.queueDone.mockRejectedValueOnce(failure);

  await expect(renderThumbnail(env.gpu as never, env.target as never)).rejects.toBe(failure);
  expect(env.settled).toHaveBeenCalledOnce();
  expect(sceneFns.destroyScene).toHaveBeenCalledWith(env.scene);
});

test('preserves the render failure while still running barriers and cleanup', async () => {
  const env = setup();
  const failure = new Error('render failed');
  sceneFns.renderScene.mockImplementationOnce(() => {
    throw failure;
  });
  env.queueDone.mockRejectedValueOnce(new Error('queue failed'));
  sceneFns.destroyScene.mockImplementationOnce(() => {
    throw new Error('cleanup failed');
  });

  await expect(renderThumbnail(env.gpu as never, env.target as never)).rejects.toBe(failure);
  expect(env.queueDone).toHaveBeenCalledOnce();
  expect(env.settled).toHaveBeenCalledOnce();
  expect(sceneFns.destroyScene).toHaveBeenCalledOnce();
});
