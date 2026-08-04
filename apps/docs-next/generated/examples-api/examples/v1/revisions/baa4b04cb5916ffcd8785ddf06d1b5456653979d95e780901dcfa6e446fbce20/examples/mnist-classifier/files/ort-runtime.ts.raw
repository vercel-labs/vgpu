/**
 * Browser coordinator: ONNX Runtime Web owns the WebGPU device, vgpu adopts it,
 * and each run's ten GPU-resident logits are visualized through a non-owning
 * wrap.
 *
 * Per run, serialized and latest-wins:
 *   create input tensor -> session.run -> retain output -> wrapBuffer ->
 *   submit -> await queue.flush() -> wrapper.dispose() -> tensor.dispose()
 *
 * The 40 bytes of output are never read back or copied; the shader computes the
 * softmax. That is an API and lifetime demonstration, not a speedup: see the
 * example copy.
 */
import type { Buffer, Gpu, Surface } from 'vgpu';
import { surface as createSurface } from 'vgpu';
import type { BrowserRendererOptions, ExampleRenderer, RenderSize } from '../../lib/example-renderer';
import {
  assertGpuTensor,
  createSharedDeviceSession,
  OrtEnvironmentError,
  OrtInitCancelled,
  withWrappedTensor,
  type OrtTensor,
  type SharedDeviceSession,
} from '../../lib/ort-webgpu';
import { LOGIT_COUNT, MODEL_INPUT_NAME, MODEL_OUTPUT_NAME, MODEL_URL } from './fixtures';
import { INPUT_SIZE } from './preprocess';
import {
  createDigitBuffer,
  createIdleLogitsBuffer,
  createVisualizer,
  writeDigit,
  type Visualizer,
} from './renderer';

export interface MnistStatus {
  readonly phase: 'initializing' | 'ready' | 'classifying' | 'unsupported' | 'error';
  readonly detail?: string;
  /** Number of completed inferences; useful for tests and the status line. */
  readonly runs?: number;
}

export interface MnistRendererOptions extends BrowserRendererOptions {
  readonly onStatus?: (status: MnistStatus) => void;
}

export interface MnistRenderer extends ExampleRenderer {
  /**
   * Queues a normalized 28x28 input. Runs are serialized and only the newest
   * pending input survives, so rapid drawing never overlaps inference.
   */
  classify(pixels: Float32Array): void;
  /** Clears the bars and the input preview without running the model. */
  clear(): void;
}

export function createRenderer(options: MnistRendererOptions): MnistRenderer {
  let disposed = false;
  let reportedError = false;
  let shared: SharedDeviceSession | undefined;
  let gpu: Gpu | undefined;
  let surface: Surface | undefined;
  let visualizer: Visualizer | undefined;
  let digitBuffer: Buffer | undefined;
  let idleLogits: Buffer | undefined;
  let drain: Promise<void> | undefined;
  let shutdown: Promise<void> | undefined;
  let observer: ResizeObserver | undefined;
  let resizeFrame = 0;
  let pendingSize: RenderSize | undefined;
  let lastDpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio;
  let loggedEvidence = false;
  let runs = 0;

  /** Newest queued input; older ones are dropped on purpose. */
  let pending: Float32Array | undefined;
  /** Monotonic request id so stale completions never repaint. */
  let requested = 0;
  /** Last input actually classified, replayed on resize. */
  let lastInput: Float32Array | undefined;
  let hasResult = false;

  const status = (next: MnistStatus) => {
    try {
      options.onStatus?.({ runs, ...next });
    } catch {
      // Status reporting must never break rendering.
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
      // The borrowed output cannot be retained across frames, so re-run the
      // cached input rather than redrawing from a freed buffer.
      if (lastInput) classify(lastInput);
      else drawIdle();
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

  /** Draws the current state with vgpu-owned buffers only. */
  function drawIdle(): void {
    if (disposed || !gpu || !surface || !visualizer || !digitBuffer || !idleLogits) return;
    visualizer.render(gpu, surface, idleLogits, digitBuffer, false);
  }

  function classify(pixels: Float32Array): void {
    if (disposed) return;
    if (pixels.length !== INPUT_SIZE * INPUT_SIZE) {
      handleFailure(new Error(`Expected ${INPUT_SIZE * INPUT_SIZE} input values, received ${pixels.length}.`));
      return;
    }
    pending = pixels;
    requested++;
    drain ??= runDrainLoop().finally(() => {
      drain = undefined;
    });
  }

  /** One loop at a time; it consumes the newest pending input until none is left. */
  async function runDrainLoop(): Promise<void> {
    while (!disposed && pending) {
      const pixels = pending;
      pending = undefined;
      const generation = requested;
      await runOnce(pixels, generation);
    }
  }

  async function runOnce(pixels: Float32Array, generation: number): Promise<void> {
    if (disposed || !shared || !gpu || !surface || !visualizer || !digitBuffer) return;
    const { ort, session } = shared;
    status({ phase: 'classifying' });

    const inputName = session.inputNames[0] ?? MODEL_INPUT_NAME;
    const outputName = session.outputNames[0] ?? MODEL_OUTPUT_NAME;
    const input = new ort.Tensor('float32', pixels, [1, 1, INPUT_SIZE, INPUT_SIZE]);
    let output: OrtTensor | undefined;
    try {
      const outputs = await session.run({ [inputName]: input });
      output = outputs[outputName];
      const raw = assertGpuTensor(output, {
        dataType: 'float32',
        dims: [1, LOGIT_COUNT],
        label: 'mnist-classifier logits',
      });
      // A newer request arrived while this one ran: drop the result instead of
      // repainting stale bars. The lifetime below still runs in `finally`.
      if (disposed || generation !== requested) return;

      writeDigit(digitBuffer, pixels);
      lastInput = pixels;
      await withWrappedTensor(gpu, raw, (wrapped) => {
        if (!loggedEvidence) {
          loggedEvidence = true;
          // One-time diagnostic: makes the interop contract observable without
          // reading any logits back to the CPU.
          console.info('[mnist-classifier] interop', {
            deviceIdentity: gpu!.gpu === shared!.device,
            outputLocation: 'gpu-buffer',
            outputBytes: raw.size,
            wrapperRawIdentity: wrapped.gpu === raw,
            dims: [1, LOGIT_COUNT],
          });
        }
        visualizer!.render(gpu!, surface!, wrapped, digitBuffer!, true);
      });
      hasResult = true;
      runs++;
      status({ phase: 'ready' });
    } finally {
      output?.dispose();
      input.dispose();
    }
  }

  function clear(): void {
    if (disposed) return;
    pending = undefined;
    requested++;
    lastInput = undefined;
    hasResult = false;
    if (digitBuffer) writeDigit(digitBuffer, new Float32Array(INPUT_SIZE * INPUT_SIZE));
    drawIdle();
    status({ phase: 'ready' });
  }

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    pending = undefined;
    if (resizeFrame) cancelAnimationFrame(resizeFrame);
    resizeFrame = 0;
    pendingSize = undefined;
    observer?.disconnect();
    observer = undefined;
    if (typeof window !== 'undefined') window.removeEventListener('resize', onWindowResize);
    const active = drain;
    // One idempotent async shutdown: let the in-flight run finish its own
    // cleanup (flush, wrapper, tensor) before releasing what it borrowed.
    shutdown ??= (async () => {
      await Promise.allSettled([active ?? Promise.resolve()]);
      visualizer?.dispose();
      visualizer = undefined;
      idleLogits?.dispose();
      idleLogits = undefined;
      digitBuffer?.dispose();
      digitBuffer = undefined;
      surface?.dispose();
      surface = undefined;
      // vgpu facade first, ORT session last; the adopted device is never destroyed.
      await shared?.release();
      shared = undefined;
      gpu = undefined;
    })().catch(() => undefined);
  };

  const initialize = async () => {
    status({ phase: 'initializing' });
    shared = await createSharedDeviceSession({
      modelUrl: MODEL_URL,
      label: 'mnist-classifier',
      isCancelled: () => disposed,
      onStage: (stage) => status({ phase: 'initializing', detail: stage }),
    });
    if (disposed) return;
    gpu = shared.gpu;
    surface = createSurface(gpu, options.canvas, { dpr: [1, 2] });
    visualizer = createVisualizer(gpu);
    digitBuffer = createDigitBuffer(gpu);
    idleLogits = createIdleLogitsBuffer(gpu);

    observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure);
    observer?.observe(options.canvas);
    window.addEventListener('resize', onWindowResize);
    measure();
    drawIdle();
    status({ phase: 'ready' });
  };

  function handleFailure(error: unknown): void {
    if (disposed || error instanceof OrtInitCancelled) return;
    if (!reportedError) {
      reportedError = true;
      status({
        phase: error instanceof OrtEnvironmentError ? 'unsupported' : 'error',
        detail: error instanceof Error ? error.message : String(error),
      });
      try {
        options.onError?.(error);
      } catch {
        // Error reporting must not block teardown.
      }
    }
    dispose();
  }

  const ready = initialize().catch((error: unknown) => {
    if (disposed || error instanceof OrtInitCancelled) return;
    handleFailure(error);
    throw error;
  });

  return {
    ready,
    invalidate() {
      if (hasResult && lastInput) classify(lastInput);
      else drawIdle();
    },
    resize,
    dispose,
    classify,
    clear,
  };
}
