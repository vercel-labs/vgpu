/**
 * Shared browser bootstrap for docs examples that run ONNX Runtime Web (ORT) on
 * WebGPU and let vgpu adopt ORT's `GPUDevice`.
 *
 * Rules this module encodes once for every ML example:
 * - ORT creates and owns the device; vgpu adopts it with `initFromDevice(device)`.
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
/** ORT's own session-options type, so this module cannot drift from it. */
export type OrtSessionOptions = NonNullable<
  Parameters<OrtModule['InferenceSession']['create']>[1]
>;
/**
 * Where ORT should leave each output: one location for all of them, or a map
 * from output name to location. A two-stage pipeline wants both — bulk tensors
 * on the device, scalars the host has to branch on back on the CPU.
 */
export type OrtOutputLocation = OrtSessionOptions['preferredOutputLocation'];
export type OrtTensor = import('onnxruntime-web/webgpu').Tensor;
export type OrtSession = import('onnxruntime-web/webgpu').InferenceSession;

export interface SharedDeviceSessionOptions {
  /** Same-origin URL of the `.onnx` model. */
  readonly modelUrl: string;
  /** Reported in errors and buffer labels. */
  readonly label: string;
  /** Called after every await so a disposed renderer can abandon initialization. */
  readonly isCancelled?: () => boolean;
  /** Aborts cancellable initialization work such as the model download. */
  readonly signal?: AbortSignal;
  readonly onStage?: (stage: SharedDeviceStage) => void;
  readonly onModelProgress?: (loadedBytes: number, totalBytes: number | undefined) => void;
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
  let response: Response;
  try {
    response = await fetch(options.modelUrl, { signal: options.signal });
  } catch (error) {
    if (options.signal?.aborted || cancelled()) throw new OrtInitCancelled();
    throw error;
  }
  checkpoint();
  if (!response.ok) {
    throw new OrtEnvironmentError(
      `Model ${options.modelUrl} failed to load (HTTP ${response.status}).`,
    );
  }
  const declaredLength = Number(response.headers.get('content-length')) || undefined;
  let modelBytes: Uint8Array;
  if (response.body && options.onModelProgress) {
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let loaded = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        loaded += value.byteLength;
        options.onModelProgress(loaded, declaredLength);
        checkpoint();
      }
    } catch (error) {
      if (options.signal?.aborted || cancelled()) throw new OrtInitCancelled();
      throw error;
    }
    modelBytes = new Uint8Array(loaded);
    let offset = 0;
    for (const chunk of chunks) {
      modelBytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
  } else {
    try {
      modelBytes = new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      if (options.signal?.aborted || cancelled()) throw new OrtInitCancelled();
      throw error;
    }
  }
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

    const { initFromDevice } = await import('vgpu');
    checkpoint();
    gpu = await initFromDevice(device);
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

/**
 * {@link withWrappedTensor} for several borrowed buffers consumed by one
 * dispatch.
 *
 * A two-stage model produces one output per stage per hand, and they all have to
 * be live in the *same* dispatch — the shader reads both hands' landmarks to
 * update both brushes. Nesting `withWrappedTensor` would work but would tie the
 * wrapper lifetimes to callback nesting depth; this keeps the retain/wrap/submit/
 * flush/dispose order flat and identical no matter how many slots ran.
 *
 * Wrappers are disposed in reverse order of creation, and every one of them is
 * disposed even if an earlier disposal throws.
 */
export async function withWrappedTensors<T>(
  gpu: Gpu,
  raws: readonly GPUBuffer[],
  consume: (wrapped: readonly Buffer[]) => T,
): Promise<T> {
  const wrapped: Buffer[] = [];
  try {
    for (const raw of raws) {
      const buffer = gpu.device.wrapBuffer(raw);
      wrapped.push(buffer);
      if (buffer.gpu !== raw) {
        throw new OrtEnvironmentError(
          'wrapBuffer lost raw GPUBuffer identity; the wrap was not zero-copy.',
        );
      }
    }
    const result = consume(wrapped);
    await gpu.device.queue.flush();
    return result;
  } finally {
    for (let i = wrapped.length - 1; i >= 0; i--) {
      try {
        wrapped[i]!.dispose();
      } catch {
        // Every wrapper must get its dispose call, even if one of them throws.
      }
    }
  }
}

export interface SiblingSessionOptions {
  /** Same-origin URL of the `.onnx` model. */
  readonly modelUrl: string;
  readonly label: string;
  readonly isCancelled?: () => boolean;
  /**
   * Per-output location map or a single location. A two-stage pipeline usually
   * wants its bulk output on the GPU and a scalar or two on the CPU.
   */
  readonly preferredOutputLocation?: OrtOutputLocation;
  readonly sessionOptions?: Record<string, unknown>;
}

export interface SiblingSession {
  readonly session: OrtSession;
  readonly modelByteLength: number;
  readonly inputNames: readonly string[];
  readonly outputNames: readonly string[];
  /** Idempotent. Callers must drain in-flight runs first. */
  release(): Promise<void>;
}

/**
 * Creates a second session on the **same** ONNX Runtime instance, and therefore
 * on the same `GPUDevice`, as an existing {@link SharedDeviceSession}.
 *
 * A two-stage model needs two graphs that can hand GPU buffers to each other, so
 * they must agree on the device. ORT creates its device once per module
 * instance, so the sibling is created simply by reusing the already-imported
 * module — but "simply" is doing a lot of work in that sentence, and getting it
 * wrong yields two devices whose buffers are silently incompatible. This helper
 * exists so there is one place that does it and one place that asserts it.
 *
 * The device identity is re-checked after creation rather than assumed.
 */
export async function createSiblingSession(
  shared: SharedDeviceSession,
  options: SiblingSessionOptions,
): Promise<SiblingSession> {
  const cancelled = () => options.isCancelled?.() === true;
  const checkpoint = () => {
    if (cancelled()) throw new OrtInitCancelled();
  };

  checkpoint();
  const response = await fetch(options.modelUrl);
  checkpoint();
  if (!response.ok) {
    throw new OrtEnvironmentError(
      `Model ${options.modelUrl} failed to load (HTTP ${response.status}).`,
    );
  }
  const modelBytes = new Uint8Array(await response.arrayBuffer());
  checkpoint();

  let session: OrtSession;
  try {
    session = await shared.ort.InferenceSession.create(modelBytes, {
      executionProviders: ['webgpu'],
      preferredOutputLocation: options.preferredOutputLocation ?? 'gpu-buffer',
      ...options.sessionOptions,
    });
  } catch (error) {
    throw new OrtEnvironmentError(
      `ONNX Runtime Web could not create a WebGPU session for ${options.label}. This example does not fall back to the CPU/WASM execution provider, because that would not demonstrate device sharing.`,
      error,
    );
  }

  try {
    checkpoint();
    const device = (await shared.ort.env.webgpu.device) as GPUDevice | undefined;
    if (device !== shared.device) {
      throw new OrtEnvironmentError(
        `${options.label} was created on a different GPUDevice than its sibling session, so the two stages cannot exchange GPU buffers.`,
      );
    }
  } catch (error) {
    await session.release().catch(() => undefined);
    throw error;
  }

  let released: Promise<void> | undefined;
  return {
    session,
    modelByteLength: modelBytes.byteLength,
    inputNames: session.inputNames,
    outputNames: session.outputNames,
    release() {
      released ??= session.release();
      return released;
    },
  };
}
