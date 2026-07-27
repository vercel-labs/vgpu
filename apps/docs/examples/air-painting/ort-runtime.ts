/**
 * Browser coordinator for the air-painting example.
 *
 * ONNX Runtime Web owns the WebGPU device, vgpu adopts it, and each result's
 * GPU-resident `[1,1,17,3]` keypoints are consumed by WGSL through a non-owning
 * wrap. The 17 landmarks are never mapped, read back, or copied to the CPU.
 *
 * Per result, serialized and latest-frame-wins:
 *
 *   CPU letterbox -> uint8 input tensor -> session.run -> retain output ->
 *   wrapBuffer -> submit wrist+paint -> await queue.flush() ->
 *   wrapper.dispose() -> tensor.dispose()
 *
 * Honest about what is and is not zero-copy: the **camera preprocessing is CPU
 * side**, because the committed graph takes uint8 and the GPU-buffer input probe
 * on real hardware was rejected outright
 * (`Actual: (tensor(int32)), expected: (tensor(uint8))`). The **output** side is
 * fully zero-copy, which is what this example demonstrates.
 *
 * Two loops, deliberately decoupled: a continuous rAF display loop that
 * composites the newest frame plus the persistent mask, and this single-flight
 * inference loop. A 15 Hz pose never stalls a 60 Hz video.
 */
import type { Gpu, Surface } from 'vgpu';
import type { BrowserRendererOptions, ExampleRenderer, RenderSize } from '../../lib/example-renderer';
import {
  assertGpuTensor,
  createSharedDeviceSession,
  OrtInitCancelled,
  withWrappedTensor,
  type OrtTensor,
  type SharedDeviceSession,
  type SharedDeviceStage,
} from '../../lib/ort-webgpu';
import type { CameraSource } from './camera-source';
import { createInferenceScheduler, type InferenceScheduler } from './inference-scheduler';
import {
  KEYPOINT_DIMS,
  MODEL_INPUT_DIMS,
  MODEL_INPUT_NAME,
  MODEL_INPUT_SIZE,
  MODEL_OUTPUT_NAME,
  MODEL_URL,
} from './pose-contract';
import { createFramePreprocessor, type LetterboxContext } from './preprocess';
import { createVisualPipeline, type VisualPipeline } from './visual-pipeline';

export type AirPaintPhase =
  | 'initializing'
  | 'waiting-for-pose'
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

function createLetterboxContext(size: number): LetterboxContext {
  if (typeof OffscreenCanvas === 'function') {
    const canvas = new OffscreenCanvas(size, size);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (context) return context as unknown as LetterboxContext;
  }
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('A 2D context is required to letterbox camera frames.');
  return context as unknown as LetterboxContext;
}

const STAGE_DETAIL: Record<SharedDeviceStage, string> = {
  runtime: 'Loading ONNX Runtime Web…',
  model: 'Fetching the 9 MB pose model…',
  session: 'Creating the WebGPU session…',
  device: 'Adopting the runtime device…',
  ready: 'Waiting for a pose…',
};

export function createRenderer(options: AirPaintRendererOptions): AirPaintRenderer {
  let disposed = false;
  let reportedError = false;
  let shared: SharedDeviceSession | undefined;
  let gpu: Gpu | undefined;
  let surface: Surface | undefined;
  let pipeline: VisualPipeline | undefined;
  let scheduler: InferenceScheduler<number> | undefined;
  let shutdown: Promise<void> | undefined;
  let observer: ResizeObserver | undefined;
  let displayHandle = 0;
  let pendingSize: RenderSize | undefined;
  let resizeFrame = 0;
  let lastDpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio;
  let loggedEvidence = false;

  let runs = 0;
  let inferenceHz: number | undefined;
  let lastResultMs: number | undefined;
  let pendingReset = false;
  let copiedToken = -1;
  let hasFrame = false;
  let painting = false;
  const rate = createRateMeter();

  const preprocessor = createFramePreprocessor({
    sourceWidth: options.camera.width,
    sourceHeight: options.camera.height,
    context: createLetterboxContext(MODEL_INPUT_SIZE),
  });

  const status = (phase: AirPaintPhase, detail?: string) => {
    try {
      options.onStatus?.({ phase, detail, runs, inferenceHz });
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
   * Display loop. Never awaits inference: it copies the newest decoded frame and
   * composites the persistent mask, so video stays smooth between pose results.
   */
  const drawDisplayFrame = () => {
    displayHandle = 0;
    if (disposed || !pipeline || !surface) return;
    try {
      if (options.camera.token !== copiedToken) {
        copiedToken = options.camera.token;
        pipeline.copyExternalFrame(options.camera.frame);
        hasFrame = true;
      }
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

  /** One inference, from a fresh camera token to painted mask. */
  async function runOnce(_token: number): Promise<void> {
    if (disposed || !shared || !gpu || !pipeline) return;
    const { ort, session } = shared;

    const inputName = session.inputNames[0] ?? MODEL_INPUT_NAME;
    const outputName = session.outputNames[0] ?? MODEL_OUTPUT_NAME;

    // CPU preprocessing, labelled as such in the example copy.
    const rgb = preprocessor.read(options.camera.frame);
    const input = new ort.Tensor('uint8', rgb, [...MODEL_INPUT_DIMS]);
    let output: OrtTensor | undefined;
    try {
      const outputs = await session.run({ [inputName]: input });
      if (disposed) return;
      output = outputs[outputName];
      const raw = assertGpuTensor(output, {
        dataType: 'float32',
        dims: [...KEYPOINT_DIMS],
        label: 'air-painting keypoints',
      });

      const nowMs = performance.now();
      const dt = lastResultMs === undefined ? 1 / 30 : (nowMs - lastResultMs) / 1000;
      lastResultMs = nowMs;
      const reset = pendingReset;
      pendingReset = false;

      await withWrappedTensor(gpu, raw, (wrapped) => {
        if (!loggedEvidence) {
          loggedEvidence = true;
          // One-time diagnostic that makes the interop contract observable
          // without reading a single landmark back to the CPU.
          console.info('[air-painting] interop', {
            deviceIdentity: gpu!.gpu === shared!.device,
            outputLocation: 'gpu-buffer',
            outputBytes: raw.size,
            wrapperRawIdentity: wrapped.gpu === raw,
            dims: [...KEYPOINT_DIMS],
            inputDataType: 'uint8',
            preprocessing: 'cpu',
          });
        }
        pipeline!.consumeKeypoints(wrapped, dt, { reset });
      });

      runs++;
      inferenceHz = rate.sample(nowMs);
      painting = true;
      status('painting');
    } finally {
      // Nested and unconditional: the borrow is only safe because these run on
      // success, on error, and on cancellation alike.
      output?.dispose();
      input.dispose();
    }
  }

  const ready = (async () => {
    status('initializing', STAGE_DETAIL.runtime);
    shared = await createSharedDeviceSession({
      modelUrl: MODEL_URL,
      label: 'air-painting',
      isCancelled: () => disposed,
      onStage: (stage) => status('initializing', STAGE_DETAIL[stage]),
    });
    if (disposed) throw new OrtInitCancelled();

    gpu = shared.gpu;
    surface = gpu.surface(options.canvas, { autoResize: false });
    pipeline = createVisualPipeline(gpu, {
      sourceWidth: options.camera.width,
      sourceHeight: options.camera.height,
      label: 'air-painting',
    });

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
    status('waiting-for-pose', STAGE_DETAIL.ready);
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
        // drawn from where the wrist was before the clear.
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
          try {
            pipeline?.dispose();
          } catch {
            // Teardown must continue even if a resource is already gone.
          }
          try {
            surface?.dispose();
          } catch {
            // Same.
          }
          // vgpu never destroys ORT's device; the session is released last.
          await shared?.release().catch(() => undefined);
        }
      })();
      void shutdown;
    },
  };
}
