import type { Buffer, Gpu } from "vgpu";

type Ort = typeof import("onnxruntime-web/webgpu");
export type OrtTensor = import("onnxruntime-web/webgpu").Tensor;
type OrtSession = import("onnxruntime-web/webgpu").InferenceSession;

export class OrtInitCancelled extends Error {}

export class OrtEnvironmentError extends Error {
  name = "OrtEnvironmentError";
}

export class FirstError {
  constructor(public error?: unknown, public failed = false) {}

  capture(error: unknown): void {
    if (!this.failed) this.error = error;
    this.failed = true;
  }

  run<T>(action: () => T): T | undefined {
    try {
      return action();
    } catch (error) {
      this.capture(error);
    }
  }

  async wait(promise: Promise<unknown> | undefined): Promise<void> {
    try {
      await promise;
    } catch (error) {
      this.capture(error);
    }
  }

  throwIfAny(): void {
    if (this.failed) throw this.error;
  }
}

type Stage = "runtime" | "model" | "session" | "device";

interface SessionOptions {
  readonly modelUrl: string;
  readonly label: string;
  readonly signal?: AbortSignal;
  readonly isCancelled: () => boolean;
  readonly onStage?: (stage: Stage) => void;
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

async function waitFor<T>(promise: Promise<T>, options: SessionOptions) {
  try {
    const value = await promise;
    checkpoint(options);
    return value;
  } catch (error) {
    if (cancelled(options)) throw new OrtInitCancelled();
    throw error;
  }
}

export async function createSharedDeviceSession(options: SessionOptions) {
  if (typeof navigator === "undefined" || !navigator.gpu) {
    throw new OrtEnvironmentError(
      "This example needs WebGPU. Use a browser with WebGPU enabled (Chrome or Edge 121+)."
    );
  }

  options.onStage?.("runtime");
  const ort = (await waitFor(import("onnxruntime-web/webgpu"), options)) as Ort;
  const adapter = await waitFor(navigator.gpu.requestAdapter(), options);
  if (!adapter) {
    throw new OrtEnvironmentError(
      "No WebGPU adapter is available, so ONNX Runtime Web cannot create a device."
    );
  }

  ort.env.webgpu.adapter = adapter;
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.wasmPaths = "/ort/";

  options.onStage?.("model");
  const response = await waitFor(
    fetch(options.modelUrl, { signal: options.signal }),
    options
  );
  if (!response.ok) {
    throw new OrtEnvironmentError(
      `Model ${options.modelUrl} failed to load (HTTP ${response.status}).`
    );
  }
  const model = new Uint8Array(await waitFor(response.arrayBuffer(), options));

  options.onStage?.("session");
  let session: OrtSession;
  try {
    session = await ort.InferenceSession.create(model, {
      executionProviders: ["webgpu"],
      preferredOutputLocation: "gpu-buffer",
    });
  } catch (error) {
    if (cancelled(options)) throw new OrtInitCancelled();
    throw new OrtEnvironmentError(
      `ONNX Runtime Web could not create a WebGPU session for ${options.label}. ` +
        "This example does not fall back to the CPU/WASM execution provider, " +
        "because that would not demonstrate device sharing."
    );
  }

  let gpu: Gpu | undefined;
  try {
    checkpoint(options);
    options.onStage?.("device");
    const device = (await waitFor(
      Promise.resolve(ort.env.webgpu.device),
      options
    )) as GPUDevice | undefined;
    if (!device)
      throw new OrtEnvironmentError(
        "ONNX Runtime Web did not expose a WebGPU device, so vgpu has nothing to adopt."
      );
    const { initFromDevice } = await waitFor(import("vgpu"), options);
    try {
      gpu = await initFromDevice(device);
    } catch (error) {
      if (cancelled(options)) throw new OrtInitCancelled();
      throw error;
    }
    checkpoint(options);
    if (gpu.gpu !== device || gpu.device.gpu !== device) {
      throw new OrtEnvironmentError(
        "vgpu adopted a different GPUDevice than ONNX Runtime Web created."
      );
    }

    let released: Promise<void> | undefined;
    return {
      ort,
      session,
      gpu,
      release: () => (released ??= releaseSession(gpu, session)),
    };
  } catch (error) {
    await releaseSession(gpu, session).catch(() => undefined);
    throw error;
  }
}

export function assertGpuTensor(tensor: OrtTensor | undefined): GPUBuffer {
  const label = "mnist-classifier logits";
  if (!tensor) {
    throw new OrtEnvironmentError(
      `${label}: ONNX Runtime Web returned no output tensor.`
    );
  }
  if (tensor.type !== "float32")
    throw new OrtEnvironmentError(
      `${label}: expected float32 output, received ${tensor.type}.`
    );
  if (
    tensor.dims.length !== 2 ||
    tensor.dims[0] !== 1 ||
    tensor.dims[1] !== 10
  ) {
    throw new OrtEnvironmentError(
      `${label}: expected dims [1, 10], received [${tensor.dims.join(", ")}].`
    );
  }
  const raw = tensor.gpuBuffer as GPUBuffer | undefined;
  if (!raw) {
    throw new OrtEnvironmentError(
      `${label}: output is not GPU-resident. The session must be created with ` +
        "preferredOutputLocation: 'gpu-buffer' and must run on the WebGPU execution provider."
    );
  }
  if (raw.size < 40) {
    throw new OrtEnvironmentError(
      `${label}: GPU buffer holds ${raw.size} bytes, expected at least 40.`
    );
  }
  return raw;
}

export async function withWrappedTensor<T>(
  gpu: Gpu,
  raw: GPUBuffer,
  consume: (buffer: Buffer) => T
): Promise<T> {
  let wrapped: Buffer | undefined;
  let result: T | undefined;
  const errors = new FirstError();
  try {
    wrapped = gpu.device.wrapBuffer(raw);
    if (wrapped.gpu !== raw)
      throw new OrtEnvironmentError(
        "wrapBuffer lost raw GPUBuffer identity; the wrap was not zero-copy."
      );
    try {
      result = consume(wrapped);
    } catch (error) {
      errors.capture(error);
    }
    await errors.wait(gpu.device.queue.flush());
  } catch (error) {
    errors.capture(error);
  }
  errors.run(() => wrapped?.dispose());
  errors.throwIfAny();
  return result as T;
}

async function releaseSession(gpu: Gpu | undefined, session: OrtSession) {
  const errors = new FirstError();
  errors.run(() => gpu?.dispose());
  const releasing = errors.run(() => session.release());
  await errors.wait(releasing);
  errors.throwIfAny();
}
