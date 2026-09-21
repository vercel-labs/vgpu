import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  surface: vi.fn(),
  createSharedDeviceSession: vi.fn(),
  createSiblingSession: vi.fn(),
  createVisualPipeline: vi.fn(),
  createHandTracker: vi.fn(),
}));

vi.mock("vgpu", () => ({ surface: mocks.surface }));
vi.mock("./ort-webgpu", () => ({
  OrtInitCancelled: class extends Error {},
  assertGpuTensor: vi.fn(),
  withWrappedTensors: vi.fn(),
  createSharedDeviceSession: mocks.createSharedDeviceSession,
  createSiblingSession: mocks.createSiblingSession,
}));
vi.mock("./visual-pipeline", () => ({
  createVisualPipeline: mocks.createVisualPipeline,
}));
vi.mock("./hand-tracker", () => ({
  createHandTracker: mocks.createHandTracker,
}));
vi.mock("./hand-pipeline", () => ({
  computeLetterbox: vi.fn(),
  decodeDetections: vi.fn(),
  detectionToSquareRoi: vi.fn(),
  roiToSource: vi.fn(),
  ssdAnchors: vi.fn(() => new Float64Array()),
  weightedNms: vi.fn(),
}));

import { createCameraRenderer } from "./ort-runtime";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function setup(options: {
  readonly tensorFailure?: unknown;
  readonly run?: () => Promise<Record<string, never>>;
  readonly cameraDisposeFailure?: unknown;
  readonly observerDisconnectFailure?: unknown;
}) {
  let cameraToken = 0;
  let notify: ((token: number) => void) | undefined;
  const camera = {
    width: 640,
    height: 360,
    frame: {} as HTMLVideoElement,
    get token() {
      return cameraToken;
    },
    start: vi.fn((onFrame: (token: number) => void) => {
      notify = onFrame;
    }),
    dispose: vi.fn(() => {
      if (options.cameraDisposeFailure !== undefined)
        throw options.cameraDisposeFailure;
    }),
  };
  const gpu = {
    device: { queue: { flush: vi.fn(() => Promise.resolve()) } },
    dispose: vi.fn(),
  };
  const detectorInput = { dispose: vi.fn() };
  const landmarkInputs = [{ dispose: vi.fn() }, { dispose: vi.fn() }];
  let tensorIndex = 0;
  const fromGpuBuffer = vi.fn(() => {
    const index = tensorIndex++;
    if (index === 2 && options.tensorFailure) throw options.tensorFailure;
    return index === 0 ? detectorInput : landmarkInputs[index - 1]!;
  });
  const sessionReleaseError = new Error("session cleanup failed");
  const sharedRelease = vi.fn(async () => {
    gpu.dispose();
    throw sessionReleaseError;
  });
  const detectorRelease = vi.fn(() =>
    Promise.reject(new Error("detector cleanup failed"))
  );
  const shared = {
    gpu,
    device: {},
    ort: { Tensor: { fromGpuBuffer } },
    inputNames: ["input"],
    session: { run: vi.fn(options.run ?? (() => Promise.resolve({}))) },
    release: sharedRelease,
  };
  const detector = {
    inputNames: ["input"],
    session: { run: vi.fn() },
    release: detectorRelease,
  };
  const pipeline = {
    sourceWidth: 640,
    sourceHeight: 360,
    detectorInput: { gpu: {} },
    landmarkInput: vi.fn((slot: number) => ({ gpu: { slot } })),
    copyExternalFrame: vi.fn(),
    cropLandmarkInput: vi.fn(),
    renderVisualFrame: vi.fn(),
    clearMask: vi.fn(),
    dispose: vi.fn(),
  };
  const tracker = {
    needsDetector: vi.fn(() => false),
    activeSlots: vi.fn(() => [0]),
    noteResult: vi.fn(),
    noteMissing: vi.fn(),
    endFrame: vi.fn(),
  };
  const output = { resize: vi.fn(), size: [640, 360] };
  const observe = vi.fn();
  const disconnect = vi.fn(() => {
    if (options.observerDisconnectFailure !== undefined)
      throw options.observerDisconnectFailure;
  });
  const addEventListener = vi.fn();
  const removeEventListener = vi.fn();
  let frame = 0;

  mocks.createSharedDeviceSession.mockResolvedValue(shared);
  mocks.createSiblingSession.mockResolvedValue(detector);
  mocks.createVisualPipeline.mockReturnValue(pipeline);
  mocks.createHandTracker.mockReturnValue(tracker);
  mocks.surface.mockReturnValue(output);
  vi.stubGlobal("window", {
    devicePixelRatio: 1,
    addEventListener,
    removeEventListener,
  });
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn(() => ++frame)
  );
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe = observe;
      disconnect = disconnect;
    }
  );

  const canvas = {
    getBoundingClientRect: () => ({ width: 640, height: 360 }),
  } as HTMLCanvasElement;
  return {
    renderer: createCameraRenderer({ canvas, camera }),
    camera,
    gpu,
    shared,
    detector,
    detectorInput,
    landmarkInputs,
    pipeline,
    disconnect,
    removeEventListener,
    fireFrame(token = 1) {
      cameraToken = token;
      notify?.(token);
    },
  };
}

describe("camera renderer failure lifecycle", () => {
  beforeEach(() => vi.resetAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it("rolls back tensors and sessions when the second landmark tensor throws", async () => {
    const failure = new Error("second tensor failed");
    const env = setup({ tensorFailure: failure });

    await expect(env.renderer.ready).rejects.toBe(failure);
    await expect(env.renderer.closed).resolves.toBeUndefined();

    expect(env.detectorInput.dispose).toHaveBeenCalledOnce();
    expect(env.landmarkInputs[0]!.dispose).toHaveBeenCalledOnce();
    expect(env.landmarkInputs[1]!.dispose).not.toHaveBeenCalled();
    expect(env.detector.release).toHaveBeenCalledOnce();
    expect(env.shared.release).toHaveBeenCalledOnce();
    expect(env.gpu.dispose).toHaveBeenCalledOnce();
    expect(env.camera.dispose).toHaveBeenCalledOnce();
    expect(env.pipeline.dispose).not.toHaveBeenCalled();
  });

  it("surfaces an identical live inference failure after teardown", async () => {
    const failure = new Error("live inference failed");
    const env = setup({ run: () => Promise.reject(failure) });
    const observed = env.renderer.closed.then(
      () => undefined,
      (error: unknown) => error
    );
    await env.renderer.ready;

    env.fireFrame();
    expect(await observed).toBe(failure);

    expect(env.camera.dispose).toHaveBeenCalledOnce();
    expect(env.detectorInput.dispose).toHaveBeenCalledOnce();
    expect(
      env.landmarkInputs.every(
        (tensor) => tensor.dispose.mock.calls.length === 1
      )
    ).toBe(true);
    expect(env.detector.release).toHaveBeenCalledOnce();
    expect(env.shared.release).toHaveBeenCalledOnce();
    expect(env.gpu.dispose).toHaveBeenCalledOnce();
    expect(env.disconnect).toHaveBeenCalledOnce();
    expect(env.removeEventListener).toHaveBeenCalledWith(
      "resize",
      expect.any(Function)
    );
  });

  it("preserves a live failure when browser cleanup also throws", async () => {
    const failure = new Error("live inference failed");
    const env = setup({
      run: () => Promise.reject(failure),
      observerDisconnectFailure: new Error("observer cleanup failed"),
      cameraDisposeFailure: new Error("camera cleanup failed"),
    });
    const observed = env.renderer.closed.then(
      () => undefined,
      (error: unknown) => error
    );
    await env.renderer.ready;

    env.fireFrame();
    expect(await observed).toBe(failure);

    expect(env.disconnect).toHaveBeenCalledOnce();
    expect(env.removeEventListener).toHaveBeenCalledOnce();
    expect(env.camera.dispose).toHaveBeenCalledOnce();
    expect(env.detector.release).toHaveBeenCalledOnce();
    expect(env.shared.release).toHaveBeenCalledOnce();
    expect(env.gpu.dispose).toHaveBeenCalledOnce();
  });

  it("reports the first direct disposal error after attempting teardown", async () => {
    const active = deferred<Record<string, never>>();
    const observerFailure = new Error("observer cleanup failed");
    const env = setup({
      run: () => active.promise,
      observerDisconnectFailure: observerFailure,
      cameraDisposeFailure: new Error("camera cleanup failed"),
    });
    await env.renderer.ready;
    env.fireFrame();
    await vi.waitFor(() =>
      expect(env.shared.session.run).toHaveBeenCalledOnce()
    );

    let reported: unknown;
    try {
      env.renderer.dispose();
    } catch (error) {
      reported = error;
    }
    expect(reported).toBe(observerFailure);
    expect(env.disconnect).toHaveBeenCalledOnce();
    expect(env.removeEventListener).toHaveBeenCalledOnce();
    expect(env.camera.dispose).toHaveBeenCalledOnce();

    active.reject(new Error("stale inference failed"));
    await expect(env.renderer.closed).resolves.toBeUndefined();
    expect(env.detector.release).toHaveBeenCalledOnce();
    expect(env.shared.release).toHaveBeenCalledOnce();
    expect(env.gpu.dispose).toHaveBeenCalledOnce();
  });

  it("keeps an intentional stop quiet when the active inference later rejects", async () => {
    const active = deferred<Record<string, never>>();
    const env = setup({ run: () => active.promise });
    await env.renderer.ready;
    env.fireFrame();
    await vi.waitFor(() =>
      expect(env.shared.session.run).toHaveBeenCalledOnce()
    );

    env.renderer.dispose();
    active.reject(new Error("stale inference failed"));

    await expect(env.renderer.closed).resolves.toBeUndefined();
    expect(env.camera.dispose).toHaveBeenCalledOnce();
    expect(env.gpu.dispose).toHaveBeenCalledOnce();
  });
});
