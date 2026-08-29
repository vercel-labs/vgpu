import { surface, type Gpu, type Surface } from "vgpu";

import type { CameraSource } from "./camera-source";
import {
  createInferenceScheduler,
  type InferenceScheduler,
} from "./inference-scheduler";
import {
  DETECTOR_BOXES_OUTPUT,
  DETECTOR_INPUT_DIMS,
  DETECTOR_INPUT_NAME,
  DETECTOR_SCORES_OUTPUT,
  DETECTOR_URL,
  LANDMARK_INPUT_DIMS,
  LANDMARK_INPUT_NAME,
  LANDMARK_POINTS_DIMS,
  LANDMARK_POINTS_OUTPUT,
  LANDMARK_PRESENCE_OUTPUT,
  LANDMARK_URL,
  MAX_HANDS,
} from "./hand-model-contract";
import {
  computeLetterbox,
  decodeDetections,
  detectionToSquareRoi,
  roiToSource,
  ssdAnchors,
  weightedNms,
} from "./hand-pipeline";
import {
  createHandTracker,
  type HandCandidate,
  type HandTracker,
} from "./hand-tracker";
import {
  assertGpuTensor,
  createSharedDeviceSession,
  createSiblingSession,
  OrtInitCancelled,
  withWrappedTensors,
  type OrtTensor,
  type SharedDeviceSession,
  type SiblingSession,
} from "./ort-webgpu";
import {
  createVisualPipeline,
  type HandResultInput,
  type VisualPipeline,
} from "./visual-pipeline";

export interface CameraRenderer {
  readonly ready: Promise<void>;
  /** Rejects live failures only after teardown completes. */
  readonly closed: Promise<void>;
  clear(): void;
  dispose(): void;
}

interface RendererOptions {
  readonly canvas: HTMLCanvasElement;
  readonly camera: CameraSource;
}

interface RenderSize {
  readonly width: number;
  readonly height: number;
  readonly dpr: number;
}

export function createCameraRenderer({
  canvas,
  camera,
}: RendererOptions): CameraRenderer {
  let disposed = false;
  let shared: SharedDeviceSession | undefined;
  let detector: SiblingSession | undefined;
  let gpu: Gpu | undefined;
  let output: Surface | undefined;
  let pipeline: VisualPipeline | undefined;
  let tracker: HandTracker | undefined;
  let scheduler: InferenceScheduler<number> | undefined;
  let detectorInput: OrtTensor | undefined;
  let landmarkInputs: OrtTensor[] = [];
  let observer: ResizeObserver | undefined;
  let displayFrame = 0;
  let resizeFrame = 0;
  let pendingSize: RenderSize | undefined;
  let lastDpr = typeof window === "undefined" ? 1 : window.devicePixelRatio;
  let lastResultMs: number | undefined;
  let pendingReset = false;
  let copiedToken = -1;
  let hasFrame = false;
  let painting = false;
  let draining: Promise<void> | undefined;
  let shutdown: Promise<void> | undefined;
  let resolveClosed!: () => void;
  let rejectClosed!: (error: unknown) => void;
  const closed = new Promise<void>((resolve, reject) => {
    resolveClosed = resolve;
    rejectClosed = reject;
  });
  const anchors = ssdAnchors();

  const applyResize = () => {
    resizeFrame = 0;
    const size = pendingSize;
    pendingSize = undefined;
    if (disposed || !size || !output) return;
    try {
      output.resize([
        Math.max(1, Math.round(size.width * size.dpr)),
        Math.max(1, Math.round(size.height * size.dpr)),
      ]);
    } catch (error) {
      fail(error);
    }
  };
  const resize = (size: RenderSize) => {
    if (disposed || size.width <= 0 || size.height <= 0) return;
    pendingSize = size;
    if (!resizeFrame) resizeFrame = requestAnimationFrame(applyResize);
  };
  const measure = () => {
    const { width, height } = canvas.getBoundingClientRect();
    resize({
      width,
      height,
      dpr: Math.min(2, Math.max(1, window.devicePixelRatio || 1)),
    });
  };
  const onWindowResize = () => {
    if (window.devicePixelRatio === lastDpr) return;
    lastDpr = window.devicePixelRatio;
    measure();
  };
  const copyFrame = () => {
    if (!pipeline || camera.token === copiedToken) return;
    copiedToken = camera.token;
    pipeline.copyExternalFrame(camera.frame);
    hasFrame = true;
  };
  const draw = () => {
    displayFrame = 0;
    if (disposed || !pipeline || !output) return;
    try {
      copyFrame();
      pipeline.renderVisualFrame(output, {
        dpr: Math.min(2, Math.max(1, window.devicePixelRatio || 1)),
        hasFrame,
        showCursor: painting,
      });
    } catch (error) {
      fail(error);
    }
    displayFrame = requestAnimationFrame(draw);
  };

  async function runDetector(): Promise<void> {
    if (!pipeline || !detector || !tracker || !detectorInput || !gpu) return;
    pipeline.cropDetectorInput();
    await gpu.device.queue.flush();
    if (disposed) return;
    const tensors = await detector.session.run(
      { [detector.inputNames[0] ?? DETECTOR_INPUT_NAME]: detectorInput },
      [DETECTOR_BOXES_OUTPUT, DETECTOR_SCORES_OUTPUT]
    );
    const boxes = tensors[DETECTOR_BOXES_OUTPUT];
    const scores = tensors[DETECTOR_SCORES_OUTPUT];
    try {
      if (disposed) return;
      const boxData = boxes?.data as Float32Array | undefined;
      const scoreData = scores?.data as Float32Array | undefined;
      if (!boxData || !scoreData)
        throw new Error("The palm detector returned no output.");
      const letterbox = computeLetterbox(
        pipeline.sourceWidth,
        pipeline.sourceHeight
      );
      const detections = weightedNms(
        decodeDetections(boxData, scoreData, anchors),
        MAX_HANDS
      );
      const candidates: HandCandidate[] = detections.map((detection) => {
        const roi = roiToSource(detectionToSquareRoi(detection), letterbox);
        return { roi, centroid: { x: roi.cx, y: roi.cy } };
      });
      for (const slot of tracker.acquire(candidates)) {
        const roi = tracker.slots[slot]?.pendingRoi;
        if (roi) {
          pipeline.writeRoi(slot, roi);
          tracker.clearPending(slot);
        }
      }
    } finally {
      boxes?.dispose();
      scores?.dispose();
    }
  }

  async function runOnce(): Promise<void> {
    if (disposed || !shared || !gpu || !pipeline || !tracker) return;
    copyFrame();
    if (tracker.needsDetector()) {
      await runDetector();
      if (disposed) return;
    }

    const slots = tracker.activeSlots();
    const outputs: (OrtTensor | undefined)[] = [];
    const results: HandResultInput[] = Array.from(
      { length: MAX_HANDS },
      () => ({
        presence: 0,
      })
    );
    try {
      for (const slot of slots) {
        const input = landmarkInputs[slot];
        if (!input) continue;
        pipeline.cropLandmarkInput(slot);
        await gpu.device.queue.flush();
        if (disposed) return;
        const tensors = await shared.session.run(
          { [shared.inputNames[0] ?? LANDMARK_INPUT_NAME]: input },
          [LANDMARK_POINTS_OUTPUT, LANDMARK_PRESENCE_OUTPUT]
        );
        const points = tensors[LANDMARK_POINTS_OUTPUT];
        const presence = tensors[LANDMARK_PRESENCE_OUTPUT];
        if (disposed) {
          points?.dispose();
          presence?.dispose();
          return;
        }
        outputs[slot] = points;
        const confidence = Number(
          (presence?.data as Float32Array | undefined)?.[0] ?? 0
        );
        presence?.dispose();
        results[slot] = { presence: confidence };
        tracker.noteResult(slot, confidence);
      }
      for (let slot = 0; slot < MAX_HANDS; slot++) {
        if (!slots.includes(slot)) tracker.noteMissing(slot);
      }
      tracker.endFrame();

      const now = performance.now();
      const dt =
        lastResultMs === undefined ? 1 / 30 : (now - lastResultMs) / 1000;
      lastResultMs = now;
      const reset = pendingReset;
      pendingReset = false;
      const raws: GPUBuffer[] = [];
      const wrappedSlots: number[] = [];
      for (let slot = 0; slot < MAX_HANDS; slot++) {
        const tensor = outputs[slot];
        if (!tensor) continue;
        raws.push(
          assertGpuTensor(
            tensor,
            LANDMARK_POINTS_DIMS,
            `landmarks slot ${slot}`
          )
        );
        wrappedSlots.push(slot);
      }
      await withWrappedTensors(gpu, raws, (wrapped) => {
        const consumed = results.map((result, slot) => {
          const index = wrappedSlots.indexOf(slot);
          return index < 0 ? result : { ...result, landmarks: wrapped[index] };
        });
        pipeline!.consumeHandLandmarks(consumed, dt, { reset });
      });
      painting = tracker.activeSlots().length > 0;
    } finally {
      for (const tensor of outputs) tensor?.dispose();
    }
  }

  const initialize = async () => {
    shared = await createSharedDeviceSession({
      modelUrl: LANDMARK_URL,
      label: "hand landmarks",
      isCancelled: () => disposed,
      preferredOutputLocation: {
        [LANDMARK_POINTS_OUTPUT]: "gpu-buffer",
        [LANDMARK_PRESENCE_OUTPUT]: "cpu",
      },
    });
    if (disposed) throw new OrtInitCancelled();
    detector = await createSiblingSession(shared, {
      modelUrl: DETECTOR_URL,
      label: "palm detector",
      isCancelled: () => disposed,
      preferredOutputLocation: "cpu",
    });
    if (disposed) throw new OrtInitCancelled();

    gpu = shared.gpu;
    output = surface(gpu, canvas, { autoResize: false });
    pipeline = createVisualPipeline(gpu, {
      sourceWidth: camera.width,
      sourceHeight: camera.height,
    });
    tracker = createHandTracker({
      sourceWidth: camera.width,
      sourceHeight: camera.height,
    });
    detectorInput = shared.ort.Tensor.fromGpuBuffer(
      pipeline.detectorInput.gpu,
      {
        dataType: "float32",
        dims: [...DETECTOR_INPUT_DIMS],
      }
    );
    for (let slot = 0; slot < MAX_HANDS; slot++) {
      landmarkInputs.push(
        shared.ort.Tensor.fromGpuBuffer(pipeline.landmarkInput(slot).gpu, {
          dataType: "float32",
          dims: [...LANDMARK_INPUT_DIMS],
        })
      );
    }
    scheduler = createInferenceScheduler({ run: runOnce, onError: fail });
    measure();
    observer =
      typeof ResizeObserver === "function"
        ? new ResizeObserver(measure)
        : undefined;
    observer?.observe(canvas);
    window.addEventListener("resize", onWindowResize);
    camera.start((token) => scheduler?.request(token));
    displayFrame = requestAnimationFrame(draw);
  };

  const initialization = initialize();
  const cleanup = async () => {
    let failed = false;
    let failure: unknown;
    try {
      await draining;
    } catch (error) {
      failed = true;
      failure = error;
    }
    for (const tensor of landmarkInputs) {
      try {
        tensor.dispose();
      } catch {}
    }
    try {
      detectorInput?.dispose();
    } catch {}
    for (const release of [
      () => detector?.release(),
      () => shared?.release(),
    ]) {
      try {
        await release();
      } catch {}
    }
    if (failed) throw failure;
  };
  const teardown = () => {
    let failed = false;
    let failure: unknown;
    const attempt = (action: () => void) => {
      try {
        action();
      } catch (error) {
        if (!failed) {
          failed = true;
          failure = error;
        }
      }
    };

    if (disposed) return { failed, failure };
    disposed = true;
    attempt(() => {
      if (displayFrame) cancelAnimationFrame(displayFrame);
    });
    attempt(() => {
      if (resizeFrame) cancelAnimationFrame(resizeFrame);
    });
    attempt(() => observer?.disconnect());
    attempt(() => {
      if (typeof window !== "undefined")
        window.removeEventListener("resize", onWindowResize);
    });
    attempt(() => camera.dispose());
    attempt(() => {
      draining = scheduler?.stop();
    });
    attempt(() => {
      shutdown ??= initialization.catch(() => undefined).then(cleanup);
      void shutdown.then(resolveClosed, rejectClosed);
    });
    return { failed, failure };
  };
  const dispose = () => {
    const result = teardown();
    if (result.failed) throw result.failure;
  };
  function fail(error: unknown): never {
    teardown();
    throw error;
  }
  const ready = initialization.catch((error: unknown) => {
    if (error instanceof OrtInitCancelled || disposed) return;
    fail(error);
  });

  return {
    ready,
    closed,
    clear() {
      if (disposed) return;
      try {
        pipeline?.clearMask();
        pendingReset = true;
      } catch (error) {
        fail(error);
      }
    },
    dispose,
  };
}
