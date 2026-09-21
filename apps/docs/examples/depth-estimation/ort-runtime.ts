import GUI from "lil-gui";
import type { Buffer, Gpu, Surface } from "vgpu";
import { surface } from "vgpu";
import {
  assertGpuTensor,
  createSharedDeviceSession,
  OrtInitCancelled,
  withWrappedTensor,
  type OrtTensor,
  type SharedDeviceSession,
} from "./ort-webgpu";
import {
  createColourBuffer,
  createDepthBuffer,
  createPreprocessScratch,
  createSideBySidePipeline,
  DEFAULT_MODEL_ID,
  DEPTH_MODELS,
  getDepthModel,
  preprocessDepthSource,
  writeColour,
  type DepthModel,
  type DepthModelId,
  type PreprocessScratch,
  type SideBySidePipeline,
} from "./renderer";
import { createInferencePump, createSwitchQueue } from "./scheduling";

const SOURCE_IMAGE_URL = "/examples/depth-estimation/source.jpg";
type DepthSource = "image" | "camera";
type DepthPhase =
  | "loading-model"
  | "estimating"
  | "ready"
  | "camera-unavailable"
  | "failed";

interface ActiveSession {
  readonly shared: SharedDeviceSession;
  readonly gpu: Gpu;
  readonly output: Surface;
  readonly view: SideBySidePipeline;
  readonly idleDepth: Buffer;
  readonly colour: Buffer;
  readonly model: DepthModel;
}

interface CameraState {
  readonly stream: MediaStream;
  readonly video: HTMLVideoElement;
}

export function createDepthRenderer(canvas: HTMLCanvasElement) {
  let disposed = false;
  let modelGeneration = 0;
  let inferenceGeneration = 0;
  let model = getDepthModel(DEFAULT_MODEL_ID);
  let source: DepthSource = "image";
  let lastInferenceMs: number | undefined;
  let loadedBytes: number | undefined;
  let totalBytes: number | undefined;
  let active: ActiveSession | undefined;
  let scratch: PreprocessScratch | undefined;
  let image: HTMLImageElement | undefined;
  let camera: CameraState | undefined;
  let cameraController: AbortController | undefined;
  let cameraTask: Promise<void> | undefined;
  let observer: ResizeObserver | undefined;
  let closing: Promise<void> | undefined;
  const lifetime = new AbortController();

  const ready = deferred<void>();
  const closed = deferred<void>();
  let readySettled = false;

  const state: { model: DepthModelId; source: DepthSource; status: string } = {
    model: model.id,
    source,
    status: "initializing",
  };
  let gui: GUI | undefined;
  try {
    gui = new GUI({
      title: "Depth Estimation",
      container: canvas.parentElement ?? undefined,
    });
    Object.assign(gui.domElement.style, {
      position: "absolute",
      top: "16px",
      right: "16px",
      zIndex: "10",
    });
    const models = Object.fromEntries(
      DEPTH_MODELS.map((entry) => [entry.label, entry.id])
    );
    gui.add(state, "model", models).name("Model").onChange(setModel);
    gui
      .add(state, "source", ["image", "camera"])
      .name("Source")
      .onChange(setSource);
    gui.add(state, "status").name("Status").listen().disable();
  } catch (error) {
    try {
      gui?.destroy();
    } catch {}
    throw error;
  }

  function updateStatus(next: DepthPhase): void {
    if (disposed && next !== "failed") return;
    const progress = totalBytes
      ? ` ${Math.min(100, ((loadedBytes ?? 0) / totalBytes) * 100).toFixed(0)}%`
      : "";
    const timing =
      next === "ready" && lastInferenceMs !== undefined
        ? ` · ${lastInferenceMs.toFixed(1)} ms`
        : "";
    state.status = `${next}${next === "loading-model" ? progress : timing}`;
    state.model = model.id;
    state.source = source;
    gui
      ?.controllersRecursive()
      .forEach((controller) => controller.updateDisplay());
  }

  function currentSource(): CanvasImageSource | undefined {
    if (source === "camera")
      return camera?.video.videoWidth ? camera.video : undefined;
    return image?.naturalWidth ? image : undefined;
  }

  function draw(
    session: ActiveSession,
    depth: Buffer,
    hasResult: boolean
  ): void {
    session.view.draw(
      session.gpu,
      session.output,
      depth,
      session.colour,
      session.model,
      { hasResult }
    );
  }

  function drawIdle(session = active): void {
    if (session) draw(session, session.idleDepth, false);
  }

  function measure(): void {
    if (disposed) return;
    const session = active;
    if (!session) return;
    const { width, height } = canvas.getBoundingClientRect();
    if (width > 0 && height > 0) session.output.resize([width, height]);
    drawIdle(session);
  }

  const safeMeasure = () => {
    try {
      measure();
    } catch (error) {
      fail(error);
    }
  };

  async function runOnce(startedAt: number): Promise<void> {
    const session = active;
    const frameSource = currentSource();
    if (disposed || !session || !frameSource) return;
    updateStatus("estimating");
    scratch ??= createPreprocessScratch(
      session.model.width,
      session.model.height
    );
    const prepared = preprocessDepthSource(frameSource, session.model, scratch);
    writeColour(session.colour, prepared.rgba);
    const input = new session.shared.ort.Tensor("float32", prepared.nchw, [
      1,
      3,
      session.model.height,
      session.model.width,
    ]);
    const began = performance.now();
    let outputs: Record<string, OrtTensor> | undefined;
    const errors = new FirstError();
    try {
      outputs = await session.shared.session.run({
        [session.model.inputName]: input,
      });
      const output = outputs[session.model.outputName];
      const raw = assertGpuTensor(
        output,
        session.model.outputDims,
        `depth-estimation ${session.model.id}`
      );
      if (
        !disposed &&
        startedAt === inferenceGeneration &&
        active === session
      ) {
        await withWrappedTensor(session.gpu, raw, (wrapped) => {
          draw(session, wrapped, true);
        });
        lastInferenceMs = performance.now() - began;
        updateStatus("ready");
      }
    } catch (error) {
      errors.capture(error);
    }

    const outputTensors = Object.values(outputs ?? {}).filter(
      Boolean
    ) as OrtTensor[];
    for (const tensor of [...new Set([...outputTensors, input])]) {
      errors.run(() => tensor.dispose());
    }
    errors.throwIfAny();
  }

  const pump = createInferencePump({
    run: () => runOnce(inferenceGeneration),
    onError: fail,
    minIntervalMs: 500,
  });
  const switches = createSwitchQueue<DepthModelId>(fail);

  async function releaseActive(): Promise<void> {
    const session = active;
    active = undefined;
    if (session) await session.shared.release();
  }

  async function initialize(signal: AbortSignal): Promise<void> {
    updateStatus("loading-model");
    const target = modelGeneration;
    const selected = model;
    let shared: SharedDeviceSession | undefined;
    try {
      shared = await createSharedDeviceSession({
        modelUrl: selected.url,
        label: `depth-estimation ${selected.id}`,
        signal,
        isCancelled: () => disposed || modelGeneration !== target,
        onModelProgress(loaded, total) {
          loadedBytes = loaded;
          totalBytes = total;
          updateStatus("loading-model");
        },
        sessionOptions: { logSeverityLevel: 3 },
      });
      if (disposed || signal.aborted || modelGeneration !== target)
        throw new OrtInitCancelled();

      const next: ActiveSession = {
        shared,
        gpu: shared.gpu,
        output: surface(shared.gpu, canvas, { dpr: [1, 2] }),
        view: createSideBySidePipeline(shared.gpu),
        idleDepth: createDepthBuffer(shared.gpu, selected),
        colour: createColourBuffer(shared.gpu, selected),
        model: selected,
      };
      active = next;
      scratch ??= createPreprocessScratch(selected.width, selected.height);
      measure();
      loadedBytes = undefined;
      totalBytes = undefined;
      updateStatus("ready");
      pump.resume();
      if (source === "camera") pump.startContinuous();
      else pump.request();
      if (!readySettled) {
        readySettled = true;
        ready.resolve(undefined);
      }
    } catch (error) {
      if (shared) {
        if (active?.shared === shared) active = undefined;
        try {
          await shared.release();
        } catch (cleanupError) {
          if (error instanceof OrtInitCancelled) throw cleanupError;
        }
      }
      throw error;
    }
  }

  function queueModel(id: DepthModelId): void {
    switches.push(id, async (_selected, signal) => {
      await pump.pause();
      await releaseActive();
      if (disposed || signal.aborted || id !== model.id) return;
      await initialize(signal);
    });
  }

  function setModel(id: DepthModelId): void {
    try {
      if (disposed || id === model.id) return;
      model = getDepthModel(id);
      modelGeneration += 1;
      inferenceGeneration += 1;
      lastInferenceMs = undefined;
      loadedBytes = undefined;
      totalBytes = undefined;
      updateStatus("loading-model");
      queueModel(id);
    } catch (error) {
      fail(error);
    }
  }

  function stopCamera(): void {
    cameraController?.abort();
    cameraController = undefined;
    pump.stopContinuous();
    const current = camera;
    camera = undefined;
    if (!current) return;
    const errors = new FirstError();
    errors.run(() => current.video.pause());
    errors.run(() => {
      current.video.srcObject = null;
    });
    for (const track of current.stream.getTracks()) {
      errors.run(() => track.stop());
    }
    errors.throwIfAny();
  }

  async function startCamera(controller: AbortController): Promise<void> {
    let stream: MediaStream | undefined;
    try {
      const pending = navigator.mediaDevices?.getUserMedia({
        video: { facingMode: "user" },
        audio: false,
      });
      if (!pending) throw new Error("Camera access is unavailable.");
      stream = await abortable(pending, controller.signal, stopStream);
      if (disposed || controller.signal.aborted || source !== "camera") {
        stopStream(stream);
        return;
      }
      const video = document.createElement("video");
      video.playsInline = true;
      video.muted = true;
      video.srcObject = stream;
      const candidate = { stream, video };
      camera = candidate;
      await abortable(video.play(), controller.signal);
      if (
        disposed ||
        controller.signal.aborted ||
        source !== "camera" ||
        camera !== candidate
      ) {
        if (camera === candidate) camera = undefined;
        video.srcObject = null;
        stopStream(stream);
        return;
      }
      pump.startContinuous();
    } catch (error) {
      if (disposed || controller.signal.aborted || source !== "camera") return;
      if (stream && camera?.stream !== stream) stopStream(stream);
      stopCamera();
      source = "image";
      updateStatus("camera-unavailable");
      pump.request();
    }
  }

  function setSource(next: DepthSource): void {
    try {
      if (disposed || next === source) return;
      source = next;
      inferenceGeneration += 1;
      if (next === "image") {
        stopCamera();
        updateStatus("ready");
        pump.request();
        return;
      }
      updateStatus("estimating");
      const controller = new AbortController();
      cameraController = controller;
      let tracked: Promise<void>;
      tracked = startCamera(controller)
        .catch(fail)
        .finally(() => {
          if (cameraTask === tracked) cameraTask = undefined;
        });
      cameraTask = tracked;
    } catch (error) {
      fail(error);
    }
  }

  function fail(error: unknown): void {
    if (disposed || error instanceof OrtInitCancelled) return;
    try {
      updateStatus("failed");
    } catch {}
    shutdown(error, true);
  }

  function shutdown(primaryError?: unknown, hasPrimary = false) {
    if (closing) return { failed: false, failure: undefined };
    disposed = true;
    const errors = new FirstError(primaryError, hasPrimary);

    let pumpDrain: Promise<void> | undefined;
    let switchDrain: Promise<void> | undefined;
    errors.run(() => lifetime.abort());
    errors.run(() => {
      switches.cancel();
      switchDrain = switches.active;
    });
    errors.run(() => {
      pumpDrain = pump.stop();
    });
    errors.run(() => observer?.disconnect());
    errors.run(stopCamera);
    errors.run(() => {
      image?.removeAttribute("src");
    });
    errors.run(() => gui?.destroy());

    closing = (async () => {
      for (const pending of [pumpDrain, switchDrain, cameraTask]) {
        await errors.wait(pending);
      }
      const switchFailure = switches.failure?.error;
      if (switches.failure && !(switchFailure instanceof OrtInitCancelled)) {
        errors.capture(switchFailure);
      }
      await errors.wait(releaseActive());

      if (!readySettled) {
        readySettled = true;
        if (errors.failed) ready.reject(errors.error);
        else ready.resolve(undefined);
        return;
      }
      errors.throwIfAny();
    })();
    void closing.then(closed.resolve, closed.reject);
    return { failed: errors.failed, failure: errors.error };
  }

  const boot = async () => {
    const sourceImage = new Image();
    sourceImage.decoding = "async";
    sourceImage.src = SOURCE_IMAGE_URL;
    image = sourceImage;
    await abortable(
      sourceImage.decode().catch(() => undefined),
      lifetime.signal
    );
    if (disposed) return;
    observer =
      typeof ResizeObserver === "function"
        ? new ResizeObserver(safeMeasure)
        : undefined;
    observer?.observe(canvas);
    if (!active && !switches.busy) queueModel(model.id);
    else pump.request();
  };
  void boot().catch(fail);

  return {
    ready: ready.promise,
    closed: closed.promise,
    setModel,
    setSource,
    dispose() {
      const result = shutdown();
      if (result.failed) throw result.failure;
    },
  };
}

class FirstError {
  private first: { error: unknown } | undefined;

  constructor(error?: unknown, provided = false) {
    if (provided) this.first = { error };
  }

  get failed() {
    return this.first !== undefined;
  }

  get error() {
    return this.first?.error;
  }

  capture(error: unknown): void {
    this.first ??= { error };
  }

  run(action: () => void): void {
    try {
      action();
    } catch (error) {
      this.capture(error);
    }
  }

  async wait(promise?: PromiseLike<unknown>): Promise<void> {
    try {
      await promise;
    } catch (error) {
      this.capture(error);
    }
  }

  throwIfAny(): void {
    if (this.first) throw this.first.error;
  }
}

function stopStream(stream: MediaStream): void {
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {}
  }
}

function abortable<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  late?: (value: T) => void
) {
  if (signal.aborted) {
    void promise.then(late, () => undefined);
    return Promise.reject(new OrtInitCancelled());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      void promise.then(late, () => undefined);
      reject(new OrtInitCancelled());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
