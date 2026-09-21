import { afterEach, describe, expect, it, vi } from "vitest";

import { CameraUnavailableError, requestCamera } from "./camera-source";

class FakeVideo {
  muted = false;
  playsInline = false;
  autoplay = false;
  srcObject: MediaStream | null = null;
  readyState = 0;
  videoWidth = 0;
  videoHeight = 0;
  currentTime = 0;
  readonly play = vi.fn(() => Promise.resolve());
  readonly pause = vi.fn();
  private readonly listeners = new Map<
    string,
    Set<EventListenerOrEventListenerObject>
  >();

  addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
    const entries = this.listeners.get(type) ?? new Set();
    entries.add(listener);
    this.listeners.set(type, entries);
  }

  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject
  ) {
    this.listeners.get(type)?.delete(listener);
  }

  listenerCount(type: string) {
    return this.listeners.get(type)?.size ?? 0;
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fakeStream() {
  const stop = vi.fn();
  const stream = {
    getTracks: () => [{ stop }],
  } as unknown as MediaStream;
  return { stream, stop };
}

function installBrowser(
  getUserMedia: ReturnType<typeof vi.fn>,
  video = new FakeVideo()
) {
  const createElement = vi.fn(() => video);
  vi.stubGlobal("window", { isSecureContext: true });
  vi.stubGlobal("document", { createElement });
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  return { video, createElement };
}

describe("camera acquisition cancellation", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("releases an acquired stream while metadata is still pending", async () => {
    const { stream, stop } = fakeStream();
    const getUserMedia = vi.fn(() => Promise.resolve(stream));
    const { video } = installBrowser(getUserMedia);
    const controller = new AbortController();
    const failure = new Error("example disposed");

    const request = requestCamera(controller.signal);
    await vi.waitFor(() => {
      expect(video.listenerCount("loadedmetadata")).toBe(1);
    });
    controller.abort(failure);

    await expect(request).rejects.toBe(failure);
    expect(stop).toHaveBeenCalledOnce();
    expect(video.srcObject).toBeNull();
    expect(video.listenerCount("loadedmetadata")).toBe(0);
    expect(video.listenerCount("error")).toBe(0);
  });

  it("stops a stream that getUserMedia returns after cancellation", async () => {
    const pending = deferred<MediaStream>();
    const getUserMedia = vi.fn(() => pending.promise);
    const { createElement } = installBrowser(getUserMedia);
    const controller = new AbortController();
    const failure = new Error("example disposed");

    const request = requestCamera(controller.signal);
    controller.abort(failure);
    await expect(request).rejects.toBe(failure);
    expect(createElement).not.toHaveBeenCalled();

    const { stream, stop } = fakeStream();
    pending.resolve(stream);
    await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());
  });

  it("keeps permission failures distinguishable from cancellation", async () => {
    const denied = Object.assign(new Error("denied"), {
      name: "NotAllowedError",
    });
    installBrowser(vi.fn(() => Promise.reject(denied)));

    const error = await requestCamera(new AbortController().signal).catch(
      (failure: unknown) => failure
    );
    expect(error).toBeInstanceOf(CameraUnavailableError);
    expect(error).toMatchObject({
      message: "Camera permission was declined.",
      reason: "denied",
      detail: denied,
    });
  });
});
