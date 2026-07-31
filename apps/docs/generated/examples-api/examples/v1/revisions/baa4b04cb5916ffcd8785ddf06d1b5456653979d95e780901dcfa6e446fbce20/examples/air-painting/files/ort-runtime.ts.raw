/**
 * Browser coordinator for the air-painting example.
 *
 * ONNX Runtime Web owns the WebGPU device, vgpu adopts it, and two sessions —
 * a palm detector and a hand landmark model — share it. Both model **inputs**
 * are built by a compute shader straight into GPU buffers, and the landmark
 * **outputs** are consumed by WGSL through a non-owning wrap. On a tracked frame
 * nothing crosses to the CPU except a single float of hand presence per hand.
 *
 * Per tracked result, serialized and latest-frame-wins:
 *
 *   camera texture -> hand-crop.wgsl (ROI from GPU) -> flush ->
 *   landmark.run x{0,1,2} -> retain outputs -> wrapBuffer ->
 *   submit hand+paint -> await queue.flush() -> wrapper.dispose()
 *
 * The ROI those crops use was written by `hand.wgsl` from the *previous* frame's
 * landmarks. That loopback is what lets the detector be skipped, and it is why
 * the host can drive the whole thing without ever learning where the hand is.
 *
 * On a reacquisition frame the detector runs first and its outputs **are** read
 * back to the CPU, because anchor decoding and weighted NMS are host work with
 * no GPU implementation here. That readback is the one honest cost in this
 * design; it is rare by construction and it is measured separately in the status
 * line rather than averaged into the tracked figure.
 *
 * Two loops, deliberately decoupled: a continuous rAF display loop that
 * composites the newest frame plus the persistent mask, and this single-flight
 * inference loop. A 15 Hz hand never stalls a 60 Hz video.
 */
import type { Gpu, Surface } from 'vgpu';
import { surface as createSurface } from 'vgpu';
import type { BrowserRendererOptions, ExampleRenderer, RenderSize } from '../../lib/example-renderer';
import {
  assertGpuTensor,
  createSharedDeviceSession,
  createSiblingSession,
  OrtInitCancelled,
  withWrappedTensors,
  type OrtTensor,
  type SharedDeviceSession,
  type SharedDeviceStage,
  type SiblingSession,
} from '../../lib/ort-webgpu';
import type { CameraSource } from './camera-source';
import { createInferenceScheduler, type InferenceScheduler } from './inference-scheduler';
import {
  DETECTOR_BOXES_DIMS,
  DETECTOR_BOXES_OUTPUT,
  DETECTOR_INPUT_DIMS,
  DETECTOR_INPUT_NAME,
  DETECTOR_SCORES_DIMS,
  DETECTOR_SCORES_OUTPUT,
  DETECTOR_URL,
  LANDMARK_INPUT_DIMS,
  LANDMARK_INPUT_NAME,
  LANDMARK_POINTS_DIMS,
  LANDMARK_POINTS_OUTPUT,
  LANDMARK_PRESENCE_OUTPUT,
  LANDMARK_SIZE,
  LANDMARK_URL,
  MAX_HANDS,
} from './hand-model-contract';
import {
  computeLetterbox,
  decodeDetections,
  detectionToSquareRoi,
  mcpCentroid,
  roiToSource,
  ssdAnchors,
  weightedNms,
  type HandRoi,
} from './hand-pipeline';
import { createHandTracker, type HandCandidate, type HandTracker } from './hand-tracker';
import { createVisualPipeline, type HandResultInput, type VisualPipeline } from './visual-pipeline';

export type AirPaintPhase =
  | 'initializing'
  | 'waiting-for-hand'
  | 'painting'
  | 'unsupported'
  | 'error';

export interface AirPaintStatus {
  readonly phase: AirPaintPhase;
  readonly detail?: string;
  /** Completed inferences. */
  readonly runs: number;
  /** Rolling inference rate in Hz; the plan's floor is 15. */
  readonly inferenceHz?: number;
  /** How many of those runs had to rerun the palm detector. */
  readonly acquisitions: number;
}

export interface AirPaintRendererOptions extends BrowserRendererOptions {
  /**
   * A camera already acquired from a user gesture. The renderer takes ownership
   * and disposes it, which stops the tracks and the camera indicator.
   */
  readonly camera: CameraSource;
  readonly onStatus?: (status: AirPaintStatus) => void;
}

export interface AirPaintRenderer extends ExampleRenderer {
  /** Zeroes the paint mask and breaks stroke continuity. Nothing else changes. */
  clear(): void;
}

/** Rolling inference-rate estimate over a fixed window. */
function createRateMeter(windowMs = 1000) {
  let count = 0;
  let windowStart: number | undefined;
  let last: number | undefined;
  return {
    sample(nowMs: number): number | undefined {
      windowStart ??= nowMs;
      count++;
      const elapsed = nowMs - windowStart;
      if (elapsed < windowMs) return last;
      last = (count * 1000) / elapsed;
      count = 0;
      windowStart = nowMs;
      return last;
    },
  };
}

const STAGE_DETAIL: Record<SharedDeviceStage, string> = {
  runtime: 'Loading ONNX Runtime Web…',
  model: 'Fetching the 10 MB hand landmark model…',
  session: 'Creating the WebGPU session…',
  device: 'Adopting the runtime device…',
  ready: 'Waiting for a hand…',
};

export function createRenderer(options: AirPaintRendererOptions): AirPaintRenderer {
  let disposed = false;
  let reportedError = false;
  let shared: SharedDeviceSession | undefined;
  let detector: SiblingSession | undefined;
  let gpu: Gpu | undefined;
  let surface: Surface | undefined;
  let pipeline: VisualPipeline | undefined;
  let tracker: HandTracker | undefined;
  let scheduler: InferenceScheduler<number> | undefined;
  let shutdown: Promise<void> | undefined;
  let observer: ResizeObserver | undefined;
  let displayHandle = 0;
  let pendingSize: RenderSize | undefined;
  let resizeFrame = 0;
  let lastDpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio;
  let loggedEvidence = false;

  /** Reusable input tensors over the pipeline's persistent crop buffers. */
  let detectorInputTensor: OrtTensor | undefined;
  let landmarkInputTensors: OrtTensor[] = [];

  let runs = 0;
  let acquisitions = 0;
  let inferenceHz: number | undefined;
  let lastResultMs: number | undefined;
  let pendingReset = false;
  let copiedToken = -1;
  let hasFrame = false;
  let painting = false;
  const rate = createRateMeter();
  // 2,016 anchor centres, computed once: they depend only on the input size.
  const anchors = ssdAnchors();

  const status = (phase: AirPaintPhase, detail?: string) => {
    try {
      options.onStatus?.({ phase, detail, runs, inferenceHz, acquisitions });
    } catch {
      // Status reporting must never break rendering.
    }
  };

  const handleFailure = (error: unknown) => {
    if (error instanceof OrtInitCancelled || disposed) return;
    if (reportedError) return;
    reportedError = true;
    status('error', error instanceof Error ? error.message : String(error));
    try {
      options.onError?.(error);
    } catch {
      // The host's reporter must not mask the original failure.
    }
  };

  const applyResize = () => {
    resizeFrame = 0;
    const size = pendingSize;
    pendingSize = undefined;
    if (disposed || !size || !surface) return;
    try {
      surface.resize([
        Math.max(1, Math.round(size.width * size.dpr)),
        Math.max(1, Math.round(size.height * size.dpr)),
      ]);
      // The mask lives in normalized brush space, so nothing painted is lost.
    } catch (error) {
      handleFailure(error);
    }
  };
  const resize = (size: RenderSize) => {
    if (disposed || size.width <= 0 || size.height <= 0) return;
    pendingSize = size;
    if (!resizeFrame) resizeFrame = requestAnimationFrame(applyResize);
  };
  const measure = () => {
    const rect = options.canvas.getBoundingClientRect();
    resize({
      width: rect.width,
      height: rect.height,
      dpr: Math.min(2, Math.max(1, window.devicePixelRatio || 1)),
    });
  };
  const onWindowResize = () => {
    if (window.devicePixelRatio === lastDpr) return;
    lastDpr = window.devicePixelRatio;
    measure();
  };

  /**
   * Copies the newest decoded camera frame into the device texture, at most once
   * per frame token.
   *
   * Both loops need it — the display loop to composite and the inference loop to
   * crop — so the copy is centralized here rather than duplicated. Without this
   * the two loops would race and the models could sample a texture from before
   * the frame the scheduler was woken for.
   */
  const ensureFrameCopied = () => {
    if (!pipeline) return;
    if (options.camera.token === copiedToken) return;
    copiedToken = options.camera.token;
    pipeline.copyExternalFrame(options.camera.frame);
    hasFrame = true;
  };

  /**
   * Display loop. Never awaits inference: it copies the newest decoded frame and
   * composites the persistent mask, so video stays smooth between hand results.
   */
  const drawDisplayFrame = () => {
    displayHandle = 0;
    if (disposed || !pipeline || !surface) return;
    try {
      ensureFrameCopied();
      pipeline.renderVisualFrame(surface, {
        dpr: Math.min(2, Math.max(1, window.devicePixelRatio || 1)),
        hasFrame,
        showCursor: painting,
      });
    } catch (error) {
      handleFailure(error);
      return;
    }
    displayHandle = requestAnimationFrame(drawDisplayFrame);
  };

  /**
   * Full-frame palm search. Only runs when a track has been lost.
   *
   * This is the one place landmark-adjacent numbers reach the CPU: the detector's
   * 2,016 anchors have to be decoded and suppressed on the host, so its outputs
   * are requested as CPU tensors. It is deliberately not on the tracked path.
   */
  async function runDetector(): Promise<void> {
    if (!pipeline || !detector || !tracker || !detectorInputTensor || !gpu) return;
    acquisitions++;

    pipeline.cropDetectorInput();
    // Submit the crop before ORT enqueues its own work on the same queue.
    await gpu.device.queue.flush();
    if (disposed) return;

    const outputs = await detector.session.run(
      { [detector.inputNames[0] ?? DETECTOR_INPUT_NAME]: detectorInputTensor },
      [DETECTOR_BOXES_OUTPUT, DETECTOR_SCORES_OUTPUT],
    );
    if (disposed) return;

    const boxesTensor = outputs[DETECTOR_BOXES_OUTPUT];
    const scoresTensor = outputs[DETECTOR_SCORES_OUTPUT];
    try {
      const boxes = boxesTensor?.data as Float32Array | undefined;
      const scores = scoresTensor?.data as Float32Array | undefined;
      if (!boxes || !scores) {
        throw new Error('The palm detector returned no CPU-readable outputs.');
      }

      const letterbox = computeLetterbox(pipeline.sourceWidth, pipeline.sourceHeight);
      const detections = weightedNms(decodeDetections(boxes, scores, anchors), {
        maxDetections: MAX_HANDS,
      });
      const candidates: HandCandidate[] = detections.map((detection) => {
        const roi = roiToSource(detectionToSquareRoi(detection), letterbox);
        return { roi, centroid: { x: roi.cx, y: roi.cy }, score: detection.score };
      });

      for (const slot of tracker.acquire(candidates)) {
        const roi = tracker.slots[slot]?.pendingRoi;
        if (roi) {
          pipeline.writeRoi(slot, roi);
          tracker.clearPending(slot);
        }
      }
    } finally {
      boxesTensor?.dispose();
      scoresTensor?.dispose();
    }
  }

  /** One inference, from a fresh camera token to painted mask. */
  async function runOnce(_token: number): Promise<void> {
    if (disposed || !shared || !gpu || !pipeline || !tracker) return;
    const { session } = shared;

    ensureFrameCopied();

    if (tracker.needsDetector()) {
      await runDetector();
      if (disposed) return;
    }

    const slots = tracker.activeSlots();
    const landmarkOutputs: (OrtTensor | undefined)[] = [];
    const results: HandResultInput[] = Array.from({ length: MAX_HANDS }, () => ({
      presence: 0,
    }));

    try {
      // Sequential on purpose: the two runs share one device and one queue, and
      // overlapping them would only contend. The scheduler already guarantees
      // that no *other* frame is in flight.
      for (const slot of slots) {
        const input = landmarkInputTensors[slot];
        if (!input) continue;
        pipeline.cropLandmarkInput(slot);
        await gpu.device.queue.flush();
        if (disposed) return;

        const outputs = await session.run(
          { [session.inputNames[0] ?? LANDMARK_INPUT_NAME]: input },
          [LANDMARK_POINTS_OUTPUT, LANDMARK_PRESENCE_OUTPUT],
        );
        if (disposed) return;

        const points = outputs[LANDMARK_POINTS_OUTPUT];
        const presenceTensor = outputs[LANDMARK_PRESENCE_OUTPUT];
        landmarkOutputs[slot] = points;
        // Presence is a single float and is requested on the CPU. It is a
        // control signal, not a landmark: it decides whether the brush paints
        // and whether the detector has to run again, and both of those are host
        // decisions. The 21 landmarks it accompanies never leave the device.
        const presence = Number((presenceTensor?.data as Float32Array | undefined)?.[0] ?? 0);
        presenceTensor?.dispose();
        results[slot] = { presence };
        tracker.noteResult(slot, presence);
      }
      for (let slot = 0; slot < MAX_HANDS; slot++) {
        if (!slots.includes(slot)) tracker.noteMissing(slot);
      }
      // Closes the frame for the detector's retry throttle, which counts frames
      // rather than slot updates.
      tracker.endFrame();

      const nowMs = performance.now();
      const dt = lastResultMs === undefined ? 1 / 30 : (nowMs - lastResultMs) / 1000;
      lastResultMs = nowMs;
      const reset = pendingReset;
      pendingReset = false;

      // Every landmark buffer that actually ran, in slot order, so the wrapped
      // array indices line up with the shader's two bindings.
      const raws: GPUBuffer[] = [];
      const wrappedSlots: number[] = [];
      for (let slot = 0; slot < MAX_HANDS; slot++) {
        const tensor = landmarkOutputs[slot];
        if (!tensor) continue;
        raws.push(
          assertGpuTensor(tensor, {
            dataType: 'float32',
            dims: [...LANDMARK_POINTS_DIMS],
            label: `air-painting landmarks slot ${slot}`,
          }),
        );
        wrappedSlots.push(slot);
      }

      await withWrappedTensors(gpu, raws, (wrapped) => {
        if (!loggedEvidence && wrapped.length > 0) {
          loggedEvidence = true;
          // One-time diagnostic that makes the interop contract observable
          // without reading a single landmark back to the CPU.
          console.info('[air-painting] interop', {
            deviceIdentity: gpu!.gpu === shared!.device,
            siblingSessions: 2,
            inputLocation: 'gpu-buffer',
            inputDims: [...LANDMARK_INPUT_DIMS],
            outputLocation: 'gpu-buffer',
            outputDims: [...LANDMARK_POINTS_DIMS],
            outputBytes: raws[0]?.size,
            wrapperRawIdentity: wrapped[0]?.gpu === raws[0],
            cpuReadback: 'hand presence only (1 float per hand)',
            preprocessing: 'gpu',
          });
        }
        const consumed = results.map((result, slot) => {
          const index = wrappedSlots.indexOf(slot);
          return index >= 0 ? { ...result, landmarks: wrapped[index] } : result;
        });
        pipeline!.consumeHandLandmarks(consumed, dt, { reset });
      });

      runs++;
      inferenceHz = rate.sample(nowMs);
      painting = tracker.activeSlots().length > 0;
      status(painting ? 'painting' : 'waiting-for-hand');
    } finally {
      // Nested and unconditional: the borrow is only safe because these run on
      // success, on error, and on cancellation alike. The *input* tensors are
      // long-lived views of pipeline-owned buffers and are disposed at teardown.
      for (const tensor of landmarkOutputs) tensor?.dispose();
    }
  }

  const ready = (async () => {
    status('initializing', STAGE_DETAIL.runtime);
    shared = await createSharedDeviceSession({
      modelUrl: LANDMARK_URL,
      label: 'air-painting hand landmarks',
      isCancelled: () => disposed,
      onStage: (stage) => status('initializing', STAGE_DETAIL[stage]),
      sessionOptions: {
        // The 21 landmarks stay on the device; the presence scalar comes back on
        // the CPU because it is a control signal the host has to act on.
        preferredOutputLocation: {
          [LANDMARK_POINTS_OUTPUT]: 'gpu-buffer',
          [LANDMARK_PRESENCE_OUTPUT]: 'cpu',
        },
      },
    });
    if (disposed) throw new OrtInitCancelled();

    status('initializing', 'Fetching the 4 MB palm detector…');
    detector = await createSiblingSession(shared, {
      modelUrl: DETECTOR_URL,
      label: 'air-painting palm detector',
      isCancelled: () => disposed,
      // Anchor decoding and weighted NMS are host work, so this stage's outputs
      // are read back by design. It runs only on reacquisition.
      preferredOutputLocation: 'cpu',
    });
    if (disposed) throw new OrtInitCancelled();

    gpu = shared.gpu;
    surface = createSurface(gpu, options.canvas, { autoResize: false });
    pipeline = createVisualPipeline(gpu, {
      sourceWidth: options.camera.width,
      sourceHeight: options.camera.height,
      label: 'air-painting',
    });
    tracker = createHandTracker({
      sourceWidth: options.camera.width,
      sourceHeight: options.camera.height,
    });

    // Built once over the pipeline's persistent crop buffers, which never change
    // identity, so no tensor is allocated or freed on the hot path.
    detectorInputTensor = shared.ort.Tensor.fromGpuBuffer(pipeline.detectorInput.gpu, {
      dataType: 'float32',
      dims: [...DETECTOR_INPUT_DIMS],
    });
    landmarkInputTensors = Array.from({ length: MAX_HANDS }, (_unused, slot) =>
      shared!.ort.Tensor.fromGpuBuffer(pipeline!.landmarkInput(slot).gpu, {
        dataType: 'float32',
        dims: [...LANDMARK_INPUT_DIMS],
      }),
    );

    scheduler = createInferenceScheduler<number>({
      run: runOnce,
      onError: handleFailure,
    });

    measure();
    if (typeof ResizeObserver === 'function') {
      observer = new ResizeObserver(measure);
      observer.observe(options.canvas);
    }
    window.addEventListener('resize', onWindowResize);

    options.camera.start((token) => {
      // Fresh decoded frame: request one inference. Older pending tokens are
      // dropped by the scheduler on purpose.
      scheduler?.request(token);
    });
    displayHandle = requestAnimationFrame(drawDisplayFrame);
    status('waiting-for-hand', STAGE_DETAIL.ready);
  })().catch((error: unknown) => {
    handleFailure(error);
  });

  return {
    ready,
    invalidate() {
      // The display loop is continuous; there is nothing to coalesce.
    },
    resize,
    clear() {
      if (disposed) return;
      try {
        pipeline?.clearMask();
        // Continuity is broken on the next consumed result, so no connector is
        // drawn from where the hand was before the clear.
        pendingReset = true;
      } catch (error) {
        handleFailure(error);
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (displayHandle) cancelAnimationFrame(displayHandle);
      displayHandle = 0;
      if (resizeFrame) cancelAnimationFrame(resizeFrame);
      resizeFrame = 0;
      observer?.disconnect();
      observer = undefined;
      if (typeof window !== 'undefined') window.removeEventListener('resize', onWindowResize);
      // Stop both producers before draining, so nothing new is submitted.
      options.camera.dispose();
      const draining = scheduler?.stop();

      shutdown ??= (async () => {
        try {
          await ready.catch(() => undefined);
          await draining?.catch(() => undefined);
        } finally {
          // Input tensors are views of pipeline buffers, so they have to go
          // before the pipeline that owns those buffers.
          for (const tensor of landmarkInputTensors) {
            try {
              tensor.dispose();
            } catch {
              // Teardown must continue even if a resource is already gone.
            }
          }
          landmarkInputTensors = [];
          try {
            detectorInputTensor?.dispose();
          } catch {
            // Same.
          }
          detectorInputTensor = undefined;
          try {
            pipeline?.dispose();
          } catch {
            // Same.
          }
          try {
            surface?.dispose();
          } catch {
            // Same.
          }
          // The sibling holds no device of its own, so it is released first and
          // the facade-owning session last. vgpu never destroys ORT's device.
          await detector?.release().catch(() => undefined);
          await shared?.release().catch(() => undefined);
        }
      })();
      void shutdown;
    },
  };
}

/** Re-exported so tests can build the same measurement the shader produces. */
export function referenceMeasurement(
  landmarks: ArrayLike<number>,
  roi: HandRoi,
  sourceWidth: number,
  sourceHeight: number,
): { readonly x: number; readonly y: number } {
  const points: { x: number; y: number }[] = [];
  for (let i = 0; i < 21; i++) {
    const x = (landmarks[i * 3] ?? 0) / LANDMARK_SIZE;
    const y = (landmarks[i * 3 + 1] ?? 0) / LANDMARK_SIZE;
    const c = Math.cos(roi.rotation);
    const s = Math.sin(roi.rotation);
    const dx = (x - 0.5) * roi.size;
    const dy = (y - 0.5) * roi.size;
    points.push({ x: roi.cx + dx * c - dy * s, y: roi.cy + dx * s + dy * c });
  }
  const centroid = mcpCentroid(points);
  return { x: 1 - centroid.x / sourceWidth, y: centroid.y / sourceHeight };
}
