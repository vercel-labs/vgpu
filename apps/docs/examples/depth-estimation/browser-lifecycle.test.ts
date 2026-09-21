import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface FakeController {
  readonly object: Record<string, unknown>;
  readonly key: string;
  readonly choices: unknown;
  label: string;
  disabled: boolean;
  set(value: unknown): void;
  name(label: string): FakeController;
  onChange(callback: (value: never) => void): FakeController;
  listen(): FakeController;
  disable(): FakeController;
  updateDisplay(): FakeController;
}

interface FakeGui {
  readonly options: Record<string, unknown>;
  readonly domElement: { style: Record<string, string> };
  readonly controllers: FakeController[];
  destroy: ReturnType<typeof vi.fn>;
}

const mocks = vi.hoisted(() => ({
  guis: [] as FakeGui[],
  surface: vi.fn(),
  createShared: vi.fn(),
  assertGpuTensor: vi.fn(),
  withWrappedTensor: vi.fn(),
  createView: vi.fn(),
  createDepth: vi.fn(),
  createColour: vi.fn(),
  createScratch: vi.fn(),
  preprocess: vi.fn(),
  writeColour: vi.fn(),
  updateDisplayError: undefined as unknown,
  guiDestroyError: undefined as unknown,
}));

vi.mock("lil-gui", () => ({
  default: class {
    readonly domElement = { style: {} };
    readonly controllers: FakeController[] = [];
    readonly destroy = vi.fn(() => {
      if (mocks.guiDestroyError) throw mocks.guiDestroyError;
    });

    constructor(readonly options: Record<string, unknown>) {
      mocks.guis.push(this);
    }

    add(object: Record<string, unknown>, key: string, choices?: unknown) {
      let change: ((value: never) => void) | undefined;
      const controller: FakeController = {
        object,
        key,
        choices,
        label: key,
        disabled: false,
        set(value) {
          object[key] = value;
          change?.(value as never);
        },
        name(label) {
          controller.label = label;
          return controller;
        },
        onChange(callback) {
          change = callback;
          return controller;
        },
        listen: () => controller,
        disable() {
          controller.disabled = true;
          return controller;
        },
        updateDisplay() {
          if (mocks.updateDisplayError) throw mocks.updateDisplayError;
          return controller;
        },
      };
      this.controllers.push(controller);
      return controller;
    }

    controllersRecursive() {
      return this.controllers;
    }
  },
}));
vi.mock("vgpu", () => ({ surface: mocks.surface }));
vi.mock("./ort-webgpu", () => ({
  OrtInitCancelled: class extends Error {},
  createSharedDeviceSession: mocks.createShared,
  assertGpuTensor: mocks.assertGpuTensor,
  withWrappedTensor: mocks.withWrappedTensor,
}));
vi.mock("./renderer", () => {
  const models = [
    {
      id: "fastdepth-320x256",
      label: "FastDepth · 5.2 MiB",
      url: "/models/depth/fastdepth-320x256.onnx",
      width: 320,
      height: 256,
      inputName: "input.1",
      outputName: "424",
      outputDims: [1, 1, 256, 320],
      normalization: "rgb255",
      presentation: { mode: "log-metric", nearMeters: 0.6, farMeters: 8 },
    },
    {
      id: "midas-v21-small-256",
      label: "MiDaS v2.1 small · 63.7 MiB",
      url: "/models/depth/midas-v21-small-256.onnx",
      width: 256,
      height: 256,
      inputName: "0",
      outputName: "797",
      outputDims: [1, 256, 256],
      normalization: "rgb255",
      presentation: { mode: "auto-range" },
    },
    {
      id: "dav2-small",
      label: "Depth Anything V2 small · 94.5 MiB",
      url: "/models/depth/dav2-small.onnx",
      width: 560,
      height: 448,
      inputName: "pixel_values",
      outputName: "predicted_depth",
      outputDims: [1, 448, 560],
      normalization: "imagenet",
      presentation: { mode: "auto-range" },
    },
  ];
  return {
    DEFAULT_MODEL_ID: "fastdepth-320x256",
    DEPTH_MODELS: models,
    getDepthModel(id: string) {
      const model = models.find((entry) => entry.id === id);
      if (!model) throw new Error(`Unknown depth model: ${id}`);
      return model;
    },
    createSideBySidePipeline: mocks.createView,
    createDepthBuffer: mocks.createDepth,
    createColourBuffer: mocks.createColour,
    createPreprocessScratch: mocks.createScratch,
    preprocessDepthSource: mocks.preprocess,
    writeColour: mocks.writeColour,
  };
});

import { createDepthRenderer } from "./ort-runtime";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function fakeShared(run?: () => Promise<Record<string, unknown>>) {
  const outputTensor = { dispose: vi.fn() };
  const inputTensor = { dispose: vi.fn() };
  const Tensor = vi.fn(function () {
    return inputTensor;
  });
  const session = {
    run: vi.fn(
      run ??
        (() => Promise.resolve({ "424": outputTensor, "797": outputTensor }))
    ),
  };
  return {
    value: {
      ort: { Tensor },
      session,
      gpu: { marker: "gpu" },
      device: {},
      release: vi.fn(async () => undefined),
    },
    session,
    inputTensor,
    outputTensor,
  };
}

function setup(
  options: {
    shared?: ReturnType<typeof fakeShared>;
    sharedPromise?: Promise<ReturnType<typeof fakeShared>["value"]>;
    viewError?: unknown;
    resizeError?: unknown;
    observerError?: unknown;
    imageDecode?: Promise<void>;
    media?: Promise<MediaStream>;
  } = {}
) {
  const shared = options.shared ?? fakeShared();
  const view = { draw: vi.fn(), dispose: vi.fn() };
  const depth = { dispose: vi.fn() };
  const colour = { dispose: vi.fn() };
  const output = {
    resize: vi.fn(() => {
      if (options.resizeError) throw options.resizeError;
    }),
  };
  mocks.createShared.mockImplementation(
    () => options.sharedPromise ?? Promise.resolve(shared.value)
  );
  mocks.createView.mockImplementation(() => {
    if (options.viewError) throw options.viewError;
    return view;
  });
  mocks.createDepth.mockReturnValue(depth);
  mocks.createColour.mockReturnValue(colour);
  mocks.createScratch.mockReturnValue({});
  mocks.preprocess.mockReturnValue({
    nchw: new Float32Array(320 * 256 * 3),
    rgba: new Uint8ClampedArray(320 * 256 * 4),
  });
  mocks.assertGpuTensor.mockReturnValue({ size: 320 * 256 * 4 });
  mocks.withWrappedTensor.mockImplementation(async (_gpu, _raw, consume) =>
    consume({})
  );
  mocks.surface.mockReturnValue(output);

  const observe = vi.fn();
  const disconnect = vi.fn(() => {
    if (options.observerError) throw options.observerError;
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe = observe;
      disconnect = disconnect;
    }
  );
  const imageRemove = vi.fn();
  vi.stubGlobal(
    "Image",
    class {
      decoding = "";
      src = "";
      naturalWidth = 640;
      naturalHeight = 480;
      decode = vi.fn(() => options.imageDecode ?? Promise.resolve());
      removeAttribute = imageRemove;
    }
  );

  const video = {
    playsInline: false,
    muted: false,
    srcObject: null as MediaStream | null,
    videoWidth: 640,
    play: vi.fn(() => Promise.resolve()),
    pause: vi.fn(),
  };
  vi.stubGlobal("document", { createElement: vi.fn(() => video) });
  vi.stubGlobal("navigator", {
    mediaDevices: {
      getUserMedia: vi.fn(
        () => options.media ?? Promise.reject(new Error("denied"))
      ),
    },
  });

  const parent = {};
  const canvas = {
    parentElement: parent,
    getBoundingClientRect: () => ({ width: 800, height: 450 }),
  } as unknown as HTMLCanvasElement;
  const renderer = createDepthRenderer(canvas);
  const gui = mocks.guis.at(-1)!;
  const controller = (key: string) =>
    gui.controllers.find((entry) => entry.key === key)!;
  return {
    renderer,
    shared,
    view,
    depth,
    colour,
    output,
    observe,
    disconnect,
    imageRemove,
    video,
    gui,
    parent,
    controller,
  };
}

describe("depth browser lifecycle", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.guis.length = 0;
    mocks.updateDisplayError = undefined;
    mocks.guiDestroyError = undefined;
  });
  afterEach(() => vi.unstubAllGlobals());

  it("uses container-scoped lil-gui defaults and delegates owned VGPU cleanup to release", async () => {
    const env = setup();
    expect(env.gui.options).toMatchObject({
      title: "Depth Estimation",
      container: env.parent,
    });
    expect(env.gui.controllers.map((entry) => entry.label)).toEqual([
      "Model",
      "Source",
      "Status",
    ]);
    expect(env.controller("model").object.model).toBe("fastdepth-320x256");
    expect(env.controller("source").object.source).toBe("image");
    expect(env.controller("model").choices).toEqual({
      "FastDepth · 5.2 MiB": "fastdepth-320x256",
      "MiDaS v2.1 small · 63.7 MiB": "midas-v21-small-256",
      "Depth Anything V2 small · 94.5 MiB": "dav2-small",
    });
    expect(env.controller("source").choices).toEqual(["image", "camera"]);
    expect(env.controller("status").disabled).toBe(true);
    expect(env.controller("status").object.status).toBe("initializing");
    expect(env.gui.domElement.style).toMatchObject({
      position: "absolute",
      top: "16px",
      right: "16px",
      zIndex: "10",
    });

    await env.renderer.ready;
    await vi.waitFor(() =>
      expect(env.controller("status").object.status).toMatch(
        /^ready · \d+\.\d ms$/
      )
    );
    env.renderer.dispose();
    env.renderer.dispose();
    await env.renderer.closed;
    expect(env.gui.destroy).toHaveBeenCalledOnce();
    expect(env.shared.value.release).toHaveBeenCalledOnce();
    expect(env.view.dispose).not.toHaveBeenCalled();
    expect(env.depth.dispose).not.toHaveBeenCalled();
    expect(env.colour.dispose).not.toHaveBeenCalled();
  });

  it("propagates the model controller through serialized replacement", async () => {
    const first = fakeShared();
    const second = fakeShared();
    mocks.createShared
      .mockResolvedValueOnce(first.value)
      .mockResolvedValueOnce(second.value);
    const env = setup({ shared: first });
    mocks.createShared
      .mockResolvedValueOnce(first.value)
      .mockResolvedValueOnce(second.value);
    await env.renderer.ready;
    env.controller("model").set("midas-v21-small-256");
    await vi.waitFor(() => expect(mocks.createShared).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(first.value.release).toHaveBeenCalledOnce());
    expect(mocks.createShared.mock.calls[1]?.[0]).toMatchObject({
      modelUrl: "/models/depth/midas-v21-small-256.onnx",
    });
    env.renderer.dispose();
    await env.renderer.closed;
    expect(second.value.release).toHaveBeenCalledOnce();
  });

  it("surfaces an asynchronous model-release failure after teardown", async () => {
    const release = deferred<undefined>();
    const first = fakeShared();
    first.value.release.mockImplementation(() => release.promise);
    const env = setup({ shared: first });
    await env.renderer.ready;

    const observed = env.renderer.closed.then(
      () => undefined,
      (error: unknown) => error
    );
    env.controller("model").set("midas-v21-small-256");
    await vi.waitFor(() => expect(first.value.release).toHaveBeenCalledOnce());
    env.renderer.dispose();

    const primary = new Error("model release failed");
    release.reject(primary);
    expect(await observed).toBe(primary);
    expect(env.disconnect).toHaveBeenCalledOnce();
    expect(env.gui.destroy).toHaveBeenCalledOnce();
  });

  it("cancels a pending source image load and removes its URL on unmount", async () => {
    const imageDecode = deferred<undefined>();
    const env = setup({ imageDecode: imageDecode.promise });
    env.renderer.dispose();

    await env.renderer.closed;
    await env.renderer.ready;
    expect(env.imageRemove).toHaveBeenCalledOnce();
    expect(mocks.createShared).not.toHaveBeenCalled();

    imageDecode.resolve(undefined);
    await Promise.resolve();
    expect(mocks.createShared).not.toHaveBeenCalled();
  });

  it("still loads the default model when Camera is chosen before the image decodes", async () => {
    const imageDecode = deferred<undefined>();
    const track = { stop: vi.fn() };
    const stream = { getTracks: () => [track] } as unknown as MediaStream;
    const env = setup({
      imageDecode: imageDecode.promise,
      media: Promise.resolve(stream),
    });

    env.controller("source").set("camera");
    await vi.waitFor(() => expect(env.video.play).toHaveBeenCalledOnce());
    expect(mocks.createShared).not.toHaveBeenCalled();

    imageDecode.resolve(undefined);
    await env.renderer.ready;
    expect(mocks.createShared).toHaveBeenCalledOnce();
    expect(mocks.createShared.mock.calls[0]?.[0]).toMatchObject({
      modelUrl: "/models/depth/fastdepth-320x256.onnx",
    });
    expect(env.controller("source").object.source).toBe("camera");

    env.renderer.dispose();
    await env.renderer.closed;
    expect(track.stop).toHaveBeenCalledOnce();
  });

  it("keeps a pending model load alive when only the source changes", async () => {
    const first = fakeShared();
    const second = fakeShared();
    const replacement = deferred<typeof second.value>();
    const stream = {
      getTracks: () => [{ stop: vi.fn() }],
    } as unknown as MediaStream;
    const env = setup({ shared: first, media: Promise.resolve(stream) });
    mocks.createShared
      .mockResolvedValueOnce(first.value)
      .mockImplementationOnce(() => replacement.promise);
    await env.renderer.ready;

    env.controller("model").set("midas-v21-small-256");
    await vi.waitFor(() => expect(mocks.createShared).toHaveBeenCalledTimes(2));
    env.controller("source").set("camera");
    await vi.waitFor(() => expect(env.video.play).toHaveBeenCalledOnce());
    expect(mocks.createShared.mock.calls[1]?.[0].isCancelled()).toBe(false);

    replacement.resolve(second.value);
    await vi.waitFor(() => expect(mocks.surface).toHaveBeenCalledTimes(2));
    expect(second.value.release).not.toHaveBeenCalled();
    expect(env.controller("model").object.model).toBe("midas-v21-small-256");
    expect(env.controller("source").object.source).toBe("camera");

    env.renderer.dispose();
    await env.renderer.closed;
    expect(first.value.release).toHaveBeenCalledOnce();
    expect(second.value.release).toHaveBeenCalledOnce();
  });

  it("releases a session that resolves after unmount without constructing children", async () => {
    const pending = deferred<ReturnType<typeof fakeShared>["value"]>();
    const late = fakeShared();
    const env = setup({ sharedPromise: pending.promise });
    await vi.waitFor(() => expect(mocks.createShared).toHaveBeenCalledOnce());
    expect(env.controller("status").object.status).toBe("loading-model");
    env.renderer.dispose();
    pending.resolve(late.value);
    await env.renderer.closed;
    await env.renderer.ready;
    expect(late.value.release).toHaveBeenCalledOnce();
    expect(mocks.surface).not.toHaveBeenCalled();
  });

  it("rolls back partial VGPU construction and preserves the initialization error", async () => {
    const primary = new Error("view construction failed");
    const env = setup({ viewError: primary });
    await expect(env.renderer.ready).rejects.toBe(primary);
    await expect(env.renderer.closed).resolves.toBeUndefined();
    expect(env.shared.value.release).toHaveBeenCalledOnce();
    expect(env.gui.destroy).toHaveBeenCalledOnce();
  });

  it("preserves a live inference error when status refresh and teardown also run", async () => {
    const run = deferred<Record<string, unknown>>();
    const shared = fakeShared(() => run.promise);
    const track = { stop: vi.fn() };
    const stream = { getTracks: () => [track] } as unknown as MediaStream;
    const env = setup({ shared, media: Promise.resolve(stream) });
    const observed = env.renderer.closed.then(
      () => undefined,
      (error: unknown) => error
    );
    await env.renderer.ready;
    await vi.waitFor(() => expect(shared.session.run).toHaveBeenCalledOnce());
    env.controller("source").set("camera");
    await vi.waitFor(() => expect(env.video.play).toHaveBeenCalledOnce());
    mocks.updateDisplayError = new Error("status refresh failed");
    const primary = new Error("inference failed");
    run.reject(primary);
    expect(await observed).toBe(primary);
    expect(shared.inputTensor.dispose).toHaveBeenCalledOnce();
    expect(shared.value.release).toHaveBeenCalledOnce();
    expect(env.disconnect).toHaveBeenCalledOnce();
    expect(env.gui.destroy).toHaveBeenCalledOnce();
    expect(env.video.pause).toHaveBeenCalledOnce();
    expect(env.video.srcObject).toBeNull();
    expect(track.stop).toHaveBeenCalledOnce();
  });

  it("does not draw an inference result captured from an obsolete source", async () => {
    const run = deferred<Record<string, unknown>>();
    const media = deferred<MediaStream>();
    const shared = fakeShared(() => run.promise);
    const env = setup({ shared, media: media.promise });
    await env.renderer.ready;
    await vi.waitFor(() => expect(shared.session.run).toHaveBeenCalledOnce());

    env.controller("source").set("camera");
    run.resolve({ "424": shared.outputTensor });
    await vi.waitFor(() =>
      expect(shared.inputTensor.dispose).toHaveBeenCalledOnce()
    );
    expect(mocks.assertGpuTensor).toHaveBeenCalledOnce();
    expect(mocks.withWrappedTensor).not.toHaveBeenCalled();
    expect(shared.outputTensor.dispose).toHaveBeenCalledOnce();

    env.renderer.dispose();
    await env.renderer.closed;
    const track = { stop: vi.fn() };
    media.resolve({ getTracks: () => [track] } as unknown as MediaStream);
    await Promise.resolve();
    await Promise.resolve();
    expect(track.stop).toHaveBeenCalledOnce();
  });

  it("releases every returned tensor and preserves a draw failure over tensor cleanup", async () => {
    const run = deferred<Record<string, unknown>>();
    const shared = fakeShared(() => run.promise);
    const env = setup({ shared });
    const observed = env.renderer.closed.then(
      () => undefined,
      (error: unknown) => error
    );
    await env.renderer.ready;
    const primary = new Error("result draw failed");
    env.view.draw.mockImplementation(() => {
      throw primary;
    });
    const expected = {
      dispose: vi.fn(() => {
        throw new Error("expected tensor cleanup failed");
      }),
    };
    const extra = { dispose: vi.fn() };
    run.resolve({ "424": expected, extra });
    expect(await observed).toBe(primary);
    expect(expected.dispose).toHaveBeenCalledOnce();
    expect(extra.dispose).toHaveBeenCalledOnce();
    expect(shared.inputTensor.dispose).toHaveBeenCalledOnce();
    expect(shared.value.release).toHaveBeenCalledOnce();
  });

  it("treats an initial resize failure as fatal and still releases the session", async () => {
    const primary = new Error("resize failed");
    const env = setup({ resizeError: primary });
    await expect(env.renderer.ready).rejects.toBe(primary);
    await expect(env.renderer.closed).resolves.toBeUndefined();
    expect(env.shared.value.release).toHaveBeenCalledOnce();
  });

  it("stops media tracks that arrive after a pending camera request is aborted", async () => {
    const pending = deferred<MediaStream>();
    const track = { stop: vi.fn() };
    const stream = { getTracks: () => [track] } as unknown as MediaStream;
    const env = setup({ media: pending.promise });
    await env.renderer.ready;
    env.controller("source").set("camera");
    env.renderer.dispose();
    await env.renderer.closed;
    pending.resolve(stream);
    await Promise.resolve();
    await Promise.resolve();
    expect(track.stop).toHaveBeenCalledOnce();
  });

  it("reports the first synchronous disposal error after attempting every cleanup", async () => {
    const observerError = new Error("observer cleanup failed");
    mocks.guiDestroyError = new Error("gui cleanup failed");
    const env = setup({ observerError });
    await env.renderer.ready;
    const observed = env.renderer.closed.then(
      () => undefined,
      (error: unknown) => error
    );
    expect(() => env.renderer.dispose()).toThrow(observerError);
    expect(await observed).toBe(observerError);
    expect(env.gui.destroy).toHaveBeenCalledOnce();
    expect(env.shared.value.release).toHaveBeenCalledOnce();
  });
});
