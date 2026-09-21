import type { Buffer, Gpu } from "vgpu";

type Ort = typeof import("onnxruntime-web/webgpu");
export type OrtTensor = import("onnxruntime-web/webgpu").Tensor;
type OrtSession = import("onnxruntime-web/webgpu").InferenceSession;

export class OrtInitCancelled extends Error {}

interface SessionOptions {
  readonly modelUrl: string;
  readonly label: string;
  readonly signal?: AbortSignal;
  readonly isCancelled: () => boolean;
  readonly onModelProgress?: (loaded: number, total?: number) => void;
  readonly sessionOptions?: Record<string, unknown>;
}

export interface SharedDeviceSession {
  readonly ort: Ort;
  readonly session: OrtSession;
  readonly gpu: Gpu;
  release(): Promise<void>;
}

const cancelled = (options: SessionOptions) =>
  options.signal?.aborted === true || options.isCancelled();

const checkpoint = (options: SessionOptions) => {
  if (cancelled(options)) throw new OrtInitCancelled();
};

async function loadModel(options: SessionOptions): Promise<Uint8Array> {
  const response = await cancellable(
    fetch(options.modelUrl, { signal: options.signal }),
    options
  );
  if (!response.ok) {
    throw new Error(
      `Model ${options.modelUrl} failed to load (HTTP ${response.status}).`
    );
  }

  const total = Number(response.headers.get("content-length")) || undefined;
  if (!response.body || !options.onModelProgress) {
    return new Uint8Array(await cancellable(response.arrayBuffer(), options));
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.byteLength;
      options.onModelProgress(loaded, total);
      checkpoint(options);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (cancelled(options)) throw new OrtInitCancelled();
    throw error;
  }

  const bytes = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  checkpoint(options);
  return bytes;
}

export async function createSharedDeviceSession(
  options: SessionOptions
): Promise<SharedDeviceSession> {
  if (typeof navigator === "undefined" || !navigator.gpu) {
    throw new Error("This example needs WebGPU.");
  }

  const ort = (await cancellable(
    import("onnxruntime-web/webgpu"),
    options
  )) as Ort;
  const adapter = await cancellable(navigator.gpu.requestAdapter(), options);
  if (!adapter) throw new Error("No WebGPU adapter is available.");

  ort.env.webgpu.adapter = adapter;
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.wasmPaths = "/ort/";
  const bytes = await loadModel(options);

  let session: OrtSession;
  try {
    session = await ort.InferenceSession.create(bytes, {
      executionProviders: ["webgpu"],
      preferredOutputLocation: "gpu-buffer",
      ...options.sessionOptions,
    });
  } catch (error) {
    if (cancelled(options)) throw new OrtInitCancelled();
    throw new Error(`Could not create a WebGPU session for ${options.label}.`, {
      cause: error,
    });
  }

  let gpu: Gpu | undefined;
  try {
    checkpoint(options);
    const device = (await ort.env.webgpu.device) as GPUDevice | undefined;
    checkpoint(options);
    if (!device) throw new Error("ONNX Runtime did not expose its GPUDevice.");
    const { initFromDevice } = await import("vgpu");
    gpu = await initFromDevice(device);
    checkpoint(options);
    if (gpu.gpu !== device || gpu.device.gpu !== device) {
      throw new Error("vgpu adopted a different GPUDevice than ONNX Runtime.");
    }

    let released: Promise<void> | undefined;
    const shared = {
      ort,
      session,
      gpu,
      release() {
        return (released ??= releaseSession(gpu, session));
      },
    } satisfies SharedDeviceSession;
    return shared;
  } catch (error) {
    await releaseSession(gpu, session).catch(() => undefined);
    throw error;
  }
}

export function assertGpuTensor(
  tensor: OrtTensor | undefined,
  dims: readonly number[],
  label: string
): GPUBuffer {
  if (!tensor) throw new Error(`${label}: missing output tensor.`);
  if (tensor.type !== "float32")
    throw new Error(`${label}: expected float32 output.`);
  if (
    tensor.dims.length !== dims.length ||
    tensor.dims.some((value, i) => value !== dims[i])
  ) {
    throw new Error(`${label}: expected dimensions [${dims.join(", ")}].`);
  }
  const raw = tensor.gpuBuffer as GPUBuffer | undefined;
  const byteLength = dims.reduce((product, value) => product * value, 1) * 4;
  if (!raw || raw.size < byteLength)
    throw new Error(`${label}: output is not GPU-resident.`);
  return raw;
}

/** Keeps an ORT-owned buffer alive until all submitted vgpu work has flushed. */
export async function withWrappedTensor<T>(
  gpu: Gpu,
  raw: GPUBuffer,
  consume: (buffer: Buffer) => T
): Promise<T> {
  let wrapped: Buffer | undefined;
  let result: T | undefined;
  let failure: { error: unknown } | undefined;
  try {
    wrapped = gpu.device.wrapBuffer(raw);
    if (wrapped.gpu !== raw)
      throw new Error("wrapBuffer lost GPUBuffer identity.");
    try {
      result = consume(wrapped);
    } catch (error) {
      failure = { error };
    }
    try {
      await gpu.device.queue.flush();
    } catch (error) {
      failure ??= { error };
    }
  } catch (error) {
    failure = { error };
  }
  try {
    wrapped?.dispose();
  } catch (error) {
    failure ??= { error };
  }
  if (failure) throw failure.error;
  return result as T;
}

async function cancellable<T>(
  promise: Promise<T>,
  options: SessionOptions
): Promise<T> {
  try {
    const value = await promise;
    checkpoint(options);
    return value;
  } catch (error) {
    if (cancelled(options)) throw new OrtInitCancelled();
    throw error;
  }
}

async function releaseSession(
  gpu: Gpu | undefined,
  session: OrtSession
): Promise<void> {
  let failure: { error: unknown } | undefined;
  try {
    gpu?.dispose();
  } catch (error) {
    failure = { error };
  }
  try {
    await session.release();
  } catch (error) {
    failure ??= { error };
  }
  if (failure) throw failure.error;
}
