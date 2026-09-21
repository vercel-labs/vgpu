import { afterEach, expect, test, vi } from 'vitest';

import { loadVideo } from './video-source';

class FakeVideo extends EventTarget {
  muted = false;
  loop = false;
  playsInline = false;
  autoplay = false;
  preload = '';
  src = '';
  readyState = 0;
  videoWidth = 640;
  videoHeight = 360;
  currentTime = 0;
  play = vi.fn(async () => undefined);
  pause = vi.fn();
  removeAttribute = vi.fn();
  load = vi.fn();
}

function setup(video = new FakeVideo()) {
  vi.stubGlobal('document', { createElement: vi.fn(() => video) });
  return video;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test('aborts a pending load, removes both listeners, and releases media state', async () => {
  const video = setup();
  const remove = vi.spyOn(video, 'removeEventListener');
  const controller = new AbortController();
  const failure = new Error('unmounted');
  const loading = loadVideo('/clip.mp4', 30, controller.signal);

  controller.abort(failure);

  await expect(loading).rejects.toBe(failure);
  expect(remove).toHaveBeenCalledWith('loadeddata', expect.any(Function));
  expect(remove).toHaveBeenCalledWith('error', expect.any(Function));
  expect(video.pause).toHaveBeenCalledOnce();
  expect(video.removeAttribute).toHaveBeenCalledWith('src');
  expect(video.load).toHaveBeenCalledOnce();
});

test('cleans the opposite listener and media state when decoding fails', async () => {
  const video = setup();
  const remove = vi.spyOn(video, 'removeEventListener');
  const loading = loadVideo('/clip.mp4', 30, new AbortController().signal);

  video.dispatchEvent(new Event('error'));

  await expect(loading).rejects.toThrow('Cannot load /clip.mp4');
  expect(remove).toHaveBeenCalledWith('loadeddata', expect.any(Function));
  expect(remove).toHaveBeenCalledWith('error', expect.any(Function));
  expect(video.pause).toHaveBeenCalledOnce();
  expect(video.removeAttribute).toHaveBeenCalledWith('src');
});

test('uses decoded-frame callbacks as a one-fresh-frame signal and cancels them', async () => {
  const video = setup();
  video.readyState = 2;
  let callback: (() => void) | undefined;
  const request = vi.fn((next: () => void) => {
    callback = next;
    return 17;
  });
  const cancel = vi.fn();
  Object.assign(video, {
    requestVideoFrameCallback: request,
    cancelVideoFrameCallback: cancel,
  });

  const source = await loadVideo('/clip.mp4', 30, new AbortController().signal);
  expect(source.consume()).toBe(true);
  expect(source.consume()).toBe(false);
  callback?.();
  expect(source.consume()).toBe(true);
  expect(source.consume()).toBe(false);

  source.dispose();
  source.dispose();
  expect(cancel).toHaveBeenCalledWith(17);
  expect(video.pause).toHaveBeenCalledOnce();
});

test('quantizes the fallback clock and cancels its animation frame', async () => {
  const video = setup();
  video.readyState = 2;
  let callback: (() => void) | undefined;
  const request = vi.fn((next: () => void) => {
    callback = next;
    return 23;
  });
  const cancel = vi.fn();
  vi.stubGlobal('requestAnimationFrame', request);
  vi.stubGlobal('cancelAnimationFrame', cancel);

  const source = await loadVideo('/clip.mp4', 30, new AbortController().signal);
  source.consume();
  video.currentTime = 0.01;
  callback?.();
  expect(source.consume()).toBe(true);
  video.currentTime = 0.02;
  callback?.();
  expect(source.consume()).toBe(false);
  video.currentTime = 0.04;
  callback?.();
  expect(source.consume()).toBe(true);

  source.dispose();
  expect(cancel).toHaveBeenCalledWith(23);
});
