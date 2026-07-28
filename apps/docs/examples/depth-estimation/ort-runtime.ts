/**
 * Browser lifecycle for the depth example: ONNX Runtime Web owns the GPUDevice,
 * vgpu adopts that exact device, and the depth tensor is read by the shader
 * straight out of the buffer the model wrote it to.
 *
 * Three models are selectable and each is fetched only when it is picked —
 * eagerly loading all three would be 163 MiB of downloads for a page most
 * visitors will look at once. Switching tears the previous session down in the
 * order `lib/ort-webgpu.ts` documents before building the next one.
 */
import type { Buffer, Gpu, Surface } from 'vgpu';
import {
  assertGpuTensor,
  createSharedDeviceSession,
  OrtInitCancelled,
  withWrappedTensor,
  type OrtTensor,
  type SharedDeviceSession,
} from '../../lib/ort-webgpu';
import { createInferencePump, type InferencePump } from './inference-pump';
import { createSwitchQueue } from './model-switch';
import { DEFAULT_MODEL_ID, getDepthModel, type DepthModel, type DepthModelId } from './model-contract';
import {
  createPreprocessScratch,
  preprocessDepthSource,
  type PreprocessScratch,
} from './preprocess';
import { createDepthBuffer, createSideBySidePipeline, type SideBySidePipeline } from './renderer';

/**
 * Committed, CC0-licensed indoor photograph used as the default source.
 *
 * Declared here rather than in fixtures.ts so the browser bundle never reaches
 * the 230 KB thumbnail fixture that sits next to it.
 */
export const SOURCE_IMAGE_URL = '/examples/depth-estimation/source.jpg';

export type DepthSource = 'image' | 'camera';

export type DepthPhase =
  | 'initializing'
  | 'loading-model'
  | 'estimating'
  | 'ready'
  | 'camera-unavailable'
  | 'failed';

export interface DepthStatus {
  readonly phase: DepthPhase;
  readonly modelId: DepthModelId;
  readonly source: DepthSource;
  /** Milliseconds of the last completed inference, once there is one. */
  readonly lastInferenceMs?: number;
}

export interface DepthRendererOptions {
  readonly canvas: HTMLCanvasElement;
  readonly imageUrl: string;
  readonly onStatus?: (status: DepthStatus) => void;
  readonly onError?: (error: unknown) => void;
}

export interface DepthRenderer {
  setModel(id: DepthModelId): void;
  setSource(source: DepthSource): void;
  dispose(): void;
}

export function createDepthRenderer(options: DepthRendererOptions): DepthRenderer {
  let disposed = false;
  let reportedError = false;

  let modelId: DepthModelId = DEFAULT_MODEL_ID;
  let model: DepthModel = getDepthModel(modelId);
  let source: DepthSource = 'image';
  let phase: DepthPhase = 'initializing';
  let lastInferenceMs: number | undefined;

  let shared: SharedDeviceSession | undefined;
  let gpu: Gpu | undefined;
  let surface: Surface | undefined;
  let view: SideBySidePipeline | undefined;
  let idleDepth: Buffer | undefined;
  let colour: Buffer | undefined;
  let scratch: PreprocessScratch | undefined;

  let image: HTMLImageElement | undefined;
  let video: HTMLVideoElement | undefined;
  let stream: MediaStream | undefined;
  let observer: ResizeObserver | undefined;

  /**
   * Bumped by every model or source change. A run that started before the
   * change may still be in flight; it must clean up but must not paint.
   */
  let generation = 0;

  const status = () => {
    options.onStatus?.({ phase, modelId, source, lastInferenceMs });
  };
  const setPhase = (next: DepthPhase) => {
    phase = next;
    status();
  };

  const pump: InferencePump = createInferencePump({
    run: () => runOnce(generation),
    onError: (error) => fail(error),
    minIntervalMs: 500,
  });

  // Model switches are serialized: see model-switch.ts for why overlapping
  // teardowns and loading every model clicked past are both unacceptable.
  const switches = createSwitchQueue<DepthModelId>((error) => fail(error));

  function fail(error: unknown): void {
    if (disposed || error instanceof OrtInitCancelled) return;
    if (!reportedError) {
      reportedError = true;
      setPhase('failed');
      options.onError?.(error);
    }
  }

  function measure(): void {
    if (!surface || !gpu) return;
    const rect = options.canvas.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) surface.resize([rect.width, rect.height]);
    drawIdle();
  }

  /** Paints the panel colour so the canvas is never an empty white box. */
  function drawIdle(): void {
    if (!gpu || !surface || !view || !idleDepth || !colour) return;
    view.draw(gpu, surface, idleDepth, colour, model, { hasResult: false });
  }

  function currentSource(): CanvasImageSource | undefined {
    if (source === 'camera') return video && video.videoWidth > 0 ? video : undefined;
    return image && image.naturalWidth > 0 ? image : undefined;
  }

  async function runOnce(startedAt: number): Promise<void> {
    if (disposed || !shared || !gpu || !surface || !view || !scratch) return;
    const frameSource = currentSource();
    if (!frameSource) return;

    setPhase('estimating');
    const { ort, session } = shared;
    const pixels = preprocessDepthSource(frameSource, model, scratch);
    const input = new ort.Tensor('float32', pixels, model.inputDims as unknown as number[]);
    const began = performance.now();

    let output: OrtTensor | undefined;
    try {
      const outputs = await session.run({ [model.inputName]: input });
      output = outputs[model.outputName];
      const raw = assertGpuTensor(output, {
        dataType: 'float32',
        dims: model.outputDims,
        label: `depth-estimation ${model.id}`,
      });
      // The model or source changed while this ran: release below, but do not
      // paint a result the user is no longer asking for.
      if (disposed || startedAt !== generation) return;

      await withWrappedTensor(gpu, raw, (wrapped) => {
        view!.draw(gpu!, surface!, wrapped, colour!, model, { hasResult: true });
      });
      lastInferenceMs = performance.now() - began;
      setPhase('ready');
    } finally {
      // Ordering matters: the wrapper is already gone by here, so releasing the
      // tensor is what actually frees the buffer.
      output?.dispose();
      input.dispose();
    }
  }

  async function teardownSession(): Promise<void> {
    pump.stop();
    await pump.active?.catch(() => {});
    view?.dispose();
    view = undefined;
    idleDepth?.dispose();
    idleDepth = undefined;
    colour?.dispose();
    colour = undefined;
    surface?.dispose();
    surface = undefined;
    gpu = undefined;
    // Disposes the vgpu facade first and only then the ORT session; the adopted
    // device is never destroyed here.
    await shared?.release();
    shared = undefined;
  }

  async function initialize(): Promise<void> {
    setPhase('loading-model');
    const target = generation;
    const session = await createSharedDeviceSession({
      modelUrl: model.url,
      label: `depth-estimation ${model.id}`,
      isCancelled: () => disposed || generation !== target,
      // Error and above. The transformer graphs pin their shape arithmetic to
      // CPU and ONNX Runtime says so at warning level on every session create;
      // that is expected and harmless, but it reaches the browser console as
      // console.error, where Next's dev overlay presents it as a crash. Raising
      // the threshold silences it at the source instead of filtering the
      // console, so genuine errors are still logged and still thrown.
      sessionOptions: { logSeverityLevel: 3 },
    });
    if (disposed || generation !== target) {
      await session.release();
      return;
    }

    shared = session;
    gpu = session.gpu;
    surface = gpu.surface(options.canvas, { dpr: [1, 2] });
    view = createSideBySidePipeline(gpu);
    idleDepth = createDepthBuffer(gpu, model);
    colour = createColourBuffer(gpu, model);
    scratch ??= createPreprocessScratch(model.width, model.height);

    measure();
    setPhase('ready');
    if (source === 'camera') pump.startContinuous();
    else pump.request();
  }

  async function startCamera(): Promise<void> {
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user' },
        audio: false,
      });
      if (disposed) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      const element = document.createElement('video');
      element.playsInline = true;
      element.muted = true;
      element.srcObject = stream;
      await element.play();
      video = element;
      pump.startContinuous();
    } catch (error) {
      // Denial or no camera is not fatal: fall back to the image.
      stopCamera();
      source = 'image';
      setPhase('camera-unavailable');
      pump.request();
    }
  }

  function stopCamera(): void {
    pump.stopContinuous();
    for (const track of stream?.getTracks() ?? []) track.stop();
    stream = undefined;
    if (video) {
      video.srcObject = null;
      video = undefined;
    }
  }

  const boot = async () => {
    const element = new Image();
    element.decoding = 'async';
    element.src = options.imageUrl;
    await element.decode().catch(() => undefined);
    if (disposed) return;
    image = element;

    observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure);
    observer?.observe(options.canvas);
    await initialize();
  };

  void boot().catch(fail);

  return {
    setModel(id) {
      if (disposed || id === modelId) return;
      modelId = id;
      model = getDepthModel(id);
      generation += 1;
      lastInferenceMs = undefined;
      scratch = undefined;
      // Report the choice before awaiting anything. The picker is a controlled
      // input bound to this status, so if the new id only appears once the
      // session is ready -- seconds away, and a 94 MiB download for the largest
      // model -- React restores the previous value and the click looks
      // rejected, which is exactly what a failed switch looks like.
      setPhase('loading-model');
      switches.push(id, async () => {
        await teardownSession();
        // Superseded while the old session drained.
        if (disposed || id !== modelId) return;
        await initialize();
      });
    },
    setSource(next) {
      if (disposed || next === source) return;
      source = next;
      generation += 1;
      if (next === 'camera') {
        setPhase('estimating');
        void startCamera().catch(fail);
      } else {
        stopCamera();
        setPhase('ready');
        pump.request();
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      observer?.disconnect();
      stopCamera();
      // Drain an in-flight switch first, so teardown cannot race a session
      // that is still being created.
      void Promise.resolve(switches.active)
        .catch(() => {})
        .then(() => teardownSession())
        .catch(() => {});
    },
  };
}
