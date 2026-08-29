import type { Buffer, Gpu } from "vgpu";

type Ort = typeof import("onnxruntime-web/webgpu");
export type OrtTensor = import("onnxruntime-web/webgpu").Tensor;
type OrtSession = import("onnxruntime-web/webgpu").InferenceSession;
type OutputLocation = NonNullable<
  Parameters<Ort["InferenceSession"]["create"]>[1]
>["preferredOutputLocation"];

export class OrtInitCancelled extends Error {}

interface SessionOptions {
  readonly modelUrl: string;
  readonly label: string;
  readonly isCancelled: () => boolean;
  readonly preferredOutputLocation: OutputLocation;
}

export interface SharedDeviceSession {
  readonly ort: Ort;
  readonly session: OrtSession;
  readonly gpu: Gpu;
  readonly device: GPUDevice;
  readonly inputNames: readonly string[];
  release(): Promise<void>;
}

export interface SiblingSession {
  readonly session: OrtSession;
  readonly inputNames: readonly string[];
  release(): Promise<void>;
}

const checkpoint = (isCancelled: () => boolean) => {
  if (isCancelled()) throw new OrtInitCancelled();
};

async function loadModel(
  url: string,
  isCancelled: () => boolean
): Promise<Uint8Array> {
  const response = await fetch(url);
  checkpoint(isCancelled);
  if (!response.ok)
    throw new Error(`Model ${url} failed to load (HTTP ${response.status}).`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  checkpoint(isCancelled);
  return bytes;
}

async function createSession(
  ort: Ort,
  options: SessionOptions
): Promise<OrtSession> {
  const bytes = await loadModel(options.modelUrl, options.isCancelled);
  try {
    return await ort.InferenceSession.create(bytes, {
      executionProviders: ["webgpu"],
      preferredOutputLocation: options.preferredOutputLocation,
    });
  } catch (error) {
    throw new Error(`Could not create a WebGPU session for ${options.label}.`, {
      cause: error,
    });
  }
}

export async function createSharedDeviceSession(
  options: SessionOptions
): Promise<SharedDeviceSession> {
  if (typeof navigator === "undefined" || !navigator.gpu) {
    throw new Error("This example needs WebGPU.");
  }
  const ort = (await import("onnxruntime-web/webgpu")) as Ort;
  checkpoint(options.isCancelled);
  const adapter = await navigator.gpu.requestAdapter();
  checkpoint(options.isCancelled);
  if (!adapter) throw new Error("No WebGPU adapter is available.");

  ort.env.webgpu.adapter = adapter;
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.wasmPaths = "/ort/";
  const session = await createSession(ort, options);
  let gpu: Gpu | undefined;
  try {
    checkpoint(options.isCancelled);
    const device = (await ort.env.webgpu.device) as GPUDevice | undefined;
    if (!device) throw new Error("ONNX Runtime did not expose its GPUDevice.");
    const { initFromDevice } = await import("vgpu");
    gpu = await initFromDevice(device);
    checkpoint(options.isCancelled);
    if (gpu.gpu !== device || gpu.device.gpu !== device) {
      throw new Error("vgpu adopted a different GPUDevice than ONNX Runtime.");
    }
    let released: Promise<void> | undefined;
    return {
      ort,
      session,
      gpu,
      device,
      inputNames: session.inputNames,
      release() {
        return (released ??= (async () => {
          try {
            gpu?.dispose();
          } finally {
            await session.release();
          }
        })());
      },
    };
  } catch (error) {
    try {
      gpu?.dispose();
    } catch {}
    await session.release().catch(() => undefined);
    throw error;
  }
}

export async function createSiblingSession(
  shared: SharedDeviceSession,
  options: SessionOptions
): Promise<SiblingSession> {
  checkpoint(options.isCancelled);
  const session = await createSession(shared.ort, options);
  try {
    checkpoint(options.isCancelled);
    if ((await shared.ort.env.webgpu.device) !== shared.device) {
      throw new Error(`${options.label} was created on a different GPUDevice.`);
    }
  } catch (error) {
    await session.release().catch(() => undefined);
    throw error;
  }
  let released: Promise<void> | undefined;
  return {
    session,
    inputNames: session.inputNames,
    release() {
      return (released ??= session.release());
    },
  };
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
  const bytes = dims.reduce((product, value) => product * value, 1) * 4;
  if (!raw || raw.size < bytes)
    throw new Error(`${label}: output is not GPU-resident.`);
  return raw;
}

export async function withWrappedTensors<T>(
  gpu: Gpu,
  raws: readonly GPUBuffer[],
  consume: (buffers: readonly Buffer[]) => T
): Promise<T> {
  const buffers: Buffer[] = [];
  try {
    for (const raw of raws) {
      const buffer = gpu.device.wrapBuffer(raw);
      buffers.push(buffer);
      if (buffer.gpu !== raw)
        throw new Error("wrapBuffer lost GPUBuffer identity.");
    }
    const result = consume(buffers);
    await gpu.device.queue.flush();
    return result;
  } finally {
    for (let i = buffers.length - 1; i >= 0; i--) {
      try {
        buffers[i]!.dispose();
      } catch {}
    }
  }
}
