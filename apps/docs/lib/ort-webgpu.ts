/**
 * Shared browser bootstrap for docs examples that run ONNX Runtime Web (ORT) on
 * WebGPU and let vgpu adopt ORT's `GPUDevice`.
 *
 * Rules this module encodes once for every ML example:
 * - ORT creates and owns the device; vgpu adopts it with `init({ device })`.
 * - The WASM runtime is served same-origin from `/ort/` (staged by
 *   `scripts/prepare-ort-assets.mjs`); never from a CDN.
 * - `preferredOutputLocation: 'gpu-buffer'` is mandatory and failure to obtain a
 *   GPU-resident output is a hard error, never a silent CPU fallback.
 * - Borrowed output buffers follow retain -> wrap -> submit -> flush ->
 *   wrapper.dispose() -> tensor.dispose(). `withWrappedTensor` implements the
 *   middle of that sequence; the caller still owns the tensor.
 *
 * This module must only ever be reached from browser code. `renderer.ts` files
 * (which are bundled for Node thumbnail rendering) must not import it, directly
 * or transitively.
 */
import type { Buffer, Gpu } from 'vgpu';

/** Pinned ORT version; `scripts/prepare-ort-assets.mjs` enforces the same value. */
export const ORT_VERSION = '1.27.0';

/** Same-origin directory holding the staged asyncify runtime. */
export const ORT_WASM_PATH = '/ort/';

export type OrtModule = typeof import('onnxruntime-web/webgpu');
export type OrtTensor = import('onnxruntime-web/webgpu').Tensor;
export type OrtSession = import('onnxruntime-web/webgpu').InferenceSession;

export interface SharedDeviceSessionOptions {
  /** Same-origin URL of the `.onnx` model. */
  readonly modelUrl: string;
  /** Reported in errors and buffer labels. */
  readonly label: string;
  /** Called after every await so a disposed renderer can abandon initialization. */
  readonly isCancelled?: () => boolean;
  readonly onStage?: (stage: SharedDeviceStage) => void;
  /** Extra ORT session options (free dimension overrides, graph optimization, ...). */
  readonly sessionOptions?: Record<string, unknown>;
}

export type SharedDeviceStage = 'runtime' | 'model' | 'session' | 'device' | 'ready';

export interface SharedDeviceSession {
  readonly ort: OrtModule;
  readonly session: OrtSession;
  /** vgpu facade bound to ORT's device. */
  readonly gpu: Gpu;
  /** The raw device ORT created; `gpu.gpu === device` holds. */
  readonly device: GPUDevice;
  readonly modelByteLength: number;
  readonly inputNames: readonly string[];
  readonly outputNames: readonly string[];
  /**
   * Idempotent teardown in the normative order: dispose the vgpu facade (which
   * never destroys the adopted device) and only then release the ORT session.
   * Callers must have drained in-flight runs first.
   */
  release(): Promise<void>;
}

/** Thrown when the environment cannot support the ORT-on-WebGPU requirement. */
export class OrtEnvironmentError extends Error {
  constructor(
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'OrtEnvironmentError';
  }
}

/** Cancellation is not an error; initialization resolves to `undefined` instead. */
export class OrtInitCancelled extends Error {
  constructor() {
    super('ORT initialization cancelled');
    this.name = 'OrtInitCancelled';
  }
}

function requireWebGpu(): void {
  if (typeof navigator === 'undefined' || !navigator.gpu) {
    throw new OrtEnvironmentError(
      'This example needs WebGPU. Use a browser with WebGPU enabled (Chrome or Edge 121+).',
    );
  }
}

/**
 * Creates an ORT WebGPU session and adopts its device with vgpu.
 *
 * Mirrors `experiments/ort-init-device/browser/browser.ts`, which is the proven
 * recipe for this exact ORT/vgpu version pair.
 */
export async function createSharedDeviceSession(
  options: SharedDeviceSessionOptions,
): Promise<SharedDeviceSession> {
  const cancelled = () => options.isCancelled?.() === true;
  const checkpoint = () => {
    if (cancelled()) throw new OrtInitCancelled();
  };

  requireWebGpu();
  options.onStage?.('runtime');

  // Dynamic import keeps the ~25 MiB runtime out of every other route's graph.
  const ort = (await import('onnxruntime-web/webgpu')) as OrtModule;
  checkpoint();

  const adapter = await navigator.gpu.requestAdapter();
  checkpoint();
  if (!adapter) {
    throw new OrtEnvironmentError(
      'No WebGPU adapter is available, so ONNX Runtime Web cannot create a device.',
    );
  }

  // ORT must build its device from this adapter so vgpu can adopt the same one.
  ort.env.webgpu.adapter = adapter;
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.wasmPaths = ORT_WASM_PATH;

  options.onStage?.('model');
  const response = await fetch(options.modelUrl);
  checkpoint();
  if (!response.ok) {
    throw new OrtEnvironmentError(
      `Model ${options.modelUrl} failed to load (HTTP ${response.status}).`,
    );
  }
  const modelBytes = new Uint8Array(await response.arrayBuffer());
  checkpoint();

  options.onStage?.('session');
  let session: OrtSession;
  try {
    session = await ort.InferenceSession.create(modelBytes, {
      executionProviders: ['webgpu'],
      preferredOutputLocation: 'gpu-buffer',
      ...options.sessionOptions,
    });
  } catch (error) {
    throw new OrtEnvironmentError(
      `ONNX Runtime Web could not create a WebGPU session for ${options.label}. This example does not fall back to the CPU/WASM execution provider, because that would not demonstrate device sharing.`,
      error,
    );
  }

  let gpu: Gpu | undefined;
  try {
    checkpoint();
    options.onStage?.('device');
    const device = (await ort.env.webgpu.device) as GPUDevice | undefined;
    checkpoint();
    if (!device) {
      throw new OrtEnvironmentError(
        'ONNX Runtime Web did not expose a WebGPU device, so vgpu has nothing to adopt.',
      );
    }

    const { init } = await import('vgpu');
    checkpoint();
    gpu = await init({ device });
    checkpoint();
    if (gpu.gpu !== device || gpu.device.gpu !== device) {
      throw new OrtEnvironmentError('vgpu adopted a different GPUDevice than ONNX Runtime Web created.');
    }

    let released: Promise<void> | undefined;
    const shared: SharedDeviceSession = {
      ort,
      session,
      gpu,
      device,
      modelByteLength: modelBytes.byteLength,
      inputNames: session.inputNames,
      outputNames: session.outputNames,
      release() {
        released ??= (async () => {
          // vgpu never destroys the adopted device; ORT stays the owner.
          try {
            gpu?.dispose();
          } finally {
            await session.release();
          }
        })();
        return released;
      },
    };
    options.onStage?.('ready');
    return shared;
  } catch (error) {
    try {
      gpu?.dispose();
    } catch {
      // Teardown failures must not mask the initialization error.
    }
    await session.release().catch(() => undefined);
    throw error;
  }
}

export interface GpuTensorExpectation {
  readonly dataType: 'float32' | 'int32';
  readonly dims: readonly number[];
  readonly label: string;
}

/**
 * Validates that ORT produced the expected GPU-resident tensor and returns its
 * raw buffer. Fails closed: a CPU-resident output is an error, not a fallback.
 */
export function assertGpuTensor(tensor: OrtTensor | undefined, expected: GpuTensorExpectation): GPUBuffer {
  if (!tensor) throw new OrtEnvironmentError(`${expected.label}: ONNX Runtime Web returned no output tensor.`);
  if (tensor.type !== expected.dataType) {
    throw new OrtEnvironmentError(
      `${expected.label}: expected ${expected.dataType} output, received ${tensor.type}.`,
    );
  }
  const dims = tensor.dims;
  if (dims.length !== expected.dims.length || dims.some((value, index) => value !== expected.dims[index])) {
    throw new OrtEnvironmentError(
      `${expected.label}: expected dims [${expected.dims.join(', ')}], received [${dims.join(', ')}].`,
    );
  }
  const raw = tensor.gpuBuffer as GPUBuffer | undefined;
  if (!raw) {
    throw new OrtEnvironmentError(
      `${expected.label}: output is not GPU-resident. The session must be created with preferredOutputLocation: 'gpu-buffer' and must run on the WebGPU execution provider.`,
    );
  }
  const elements = expected.dims.reduce((product, value) => product * value, 1);
  if (raw.size < elements * 4) {
    throw new OrtEnvironmentError(
      `${expected.label}: GPU buffer holds ${raw.size} bytes, expected at least ${elements * 4}.`,
    );
  }
  return raw;
}

/**
 * Wraps a borrowed ORT buffer, lets `consume` submit vgpu work against it,
 * flushes the shared queue, and always disposes the non-owning wrapper.
 *
 * The caller keeps the tensor alive until this resolves and disposes it
 * afterwards, which is what makes the borrow safe.
 */
export async function withWrappedTensor<T>(
  gpu: Gpu,
  raw: GPUBuffer,
  consume: (wrapped: Buffer) => T,
): Promise<T> {
  const wrapped = gpu.device.wrapBuffer(raw);
  try {
    if (wrapped.gpu !== raw) {
      throw new OrtEnvironmentError('wrapBuffer lost raw GPUBuffer identity; the wrap was not zero-copy.');
    }
    const result = consume(wrapped);
    // The flush must complete before the wrapper and the tensor are released,
    // otherwise ORT could recycle the buffer while the GPU still reads it.
    await gpu.device.queue.flush();
    return result;
  } finally {
    wrapped.dispose();
  }
}
