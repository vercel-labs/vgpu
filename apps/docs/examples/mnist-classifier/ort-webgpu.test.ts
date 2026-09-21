import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Gpu } from "vgpu";

const runtime = vi.hoisted(() => ({
  createSession: vi.fn(),
  initFromDevice: vi.fn(),
  env: {
    webgpu: { adapter: undefined as unknown, device: undefined as unknown },
    wasm: { numThreads: 0, wasmPaths: "" },
  },
}));

vi.mock("onnxruntime-web/webgpu", () => ({
  env: runtime.env,
  InferenceSession: { create: runtime.createSession },
}));
vi.mock("vgpu", () => ({ initFromDevice: runtime.initFromDevice }));

import {
  assertGpuTensor,
  createSharedDeviceSession,
  OrtInitCancelled,
  withWrappedTensor,
} from "./ort-webgpu";

function fakeGpu(
  options: {
    flushError?: unknown;
    disposeError?: unknown;
    identity?: boolean;
  } = {}
) {
  const order: string[] = [];
  const raw = { size: 40 } as GPUBuffer;
  const dispose = vi.fn(() => {
    order.push("dispose");
    if (options.disposeError) throw options.disposeError;
  });
  const flush = vi.fn(async () => {
    order.push("flush");
    if (options.flushError) throw options.flushError;
  });
  const gpu = {
    device: {
      wrapBuffer: vi.fn(() => ({
        gpu: options.identity === false ? {} : raw,
        dispose,
      })),
      queue: { flush },
    },
  } as unknown as Gpu;
  return { dispose, flush, gpu, order, raw };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

function browser() {
  vi.stubGlobal("navigator", {
    gpu: { requestAdapter: vi.fn(async () => ({})) },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(new Uint8Array([1, 2, 3])))
  );
}

describe("MNIST ORT ownership", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    runtime.env.webgpu.adapter = undefined;
    runtime.env.webgpu.device = undefined;
  });
  afterEach(() => vi.unstubAllGlobals());

  it("validates type, dimensions, residency, and size", () => {
    const raw = { size: 40 } as GPUBuffer;
    const tensor = { type: "float32", dims: [1, 10], gpuBuffer: raw };
    expect(assertGpuTensor(tensor as never)).toBe(raw);
    expect(() => assertGpuTensor(undefined)).toThrow("no output tensor");
    expect(() =>
      assertGpuTensor({ ...tensor, type: "int32" } as never)
    ).toThrow("float32");
    expect(() => assertGpuTensor({ ...tensor, dims: [10] } as never)).toThrow(
      "expected dims"
    );
    expect(() =>
      assertGpuTensor({ ...tensor, gpuBuffer: { size: 4 } } as never)
    ).toThrow("GPU buffer holds");
  });

  it("flushes before releasing the non-owning wrapper", async () => {
    const env = fakeGpu();
    await expect(
      withWrappedTensor(env.gpu, env.raw, () => {
        env.order.push("consume");
        return 42;
      })
    ).resolves.toBe(42);
    expect(env.order).toEqual(["consume", "flush", "dispose"]);
  });

  it("preserves the consumer failure through flush and cleanup failures", async () => {
    const primary = new Error("draw failed");
    const env = fakeGpu({
      flushError: new Error("flush failed"),
      disposeError: new Error("dispose failed"),
    });
    await expect(
      withWrappedTensor(env.gpu, env.raw, () => {
        throw primary;
      })
    ).rejects.toBe(primary);
    expect(env.flush).toHaveBeenCalledOnce();
    expect(env.dispose).toHaveBeenCalledOnce();
  });

  it("releases a wrapper after identity and flush failures", async () => {
    const identity = fakeGpu({ identity: false });
    await expect(
      withWrappedTensor(identity.gpu, identity.raw, () => undefined)
    ).rejects.toThrow("lost raw GPUBuffer identity");
    expect(identity.flush).not.toHaveBeenCalled();
    expect(identity.dispose).toHaveBeenCalledOnce();

    const flushError = new Error("flush failed");
    const flushing = fakeGpu({ flushError });
    await expect(
      withWrappedTensor(flushing.gpu, flushing.raw, () => undefined)
    ).rejects.toBe(flushError);
    expect(flushing.dispose).toHaveBeenCalledOnce();
  });

  it("aborts a pending model fetch before session construction", async () => {
    const controller = new AbortController();
    browser();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, options: { signal?: AbortSignal }) =>
          new Promise<Response>((_resolve, reject) =>
            options.signal?.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError"))
            )
          )
      )
    );
    const creating = createSharedDeviceSession({
      modelUrl: "/model.onnx",
      label: "mnist",
      signal: controller.signal,
      isCancelled: () => false,
    });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    controller.abort();
    await expect(creating).rejects.toBeInstanceOf(OrtInitCancelled);
    expect(runtime.createSession).not.toHaveBeenCalled();
  });

  it("releases a session that finishes after cancellation", async () => {
    browser();
    const pending = deferred<unknown>();
    const release = vi.fn(async () => undefined);
    let cancelled = false;
    runtime.createSession.mockReturnValue(pending.promise);
    const creating = createSharedDeviceSession({
      modelUrl: "/model.onnx",
      label: "mnist",
      isCancelled: () => cancelled,
    });
    await vi.waitFor(() =>
      expect(runtime.createSession).toHaveBeenCalledOnce()
    );
    cancelled = true;
    pending.resolve({ inputNames: [], outputNames: [], release });
    await expect(creating).rejects.toBeInstanceOf(OrtInitCancelled);
    expect(release).toHaveBeenCalledOnce();
    expect(runtime.initFromDevice).not.toHaveBeenCalled();
  });

  it("rolls back a session when device adoption fails", async () => {
    browser();
    const primary = new Error("adoption failed");
    const release = vi.fn(async () => undefined);
    runtime.createSession.mockResolvedValue({
      inputNames: [],
      outputNames: [],
      release,
    });
    runtime.env.webgpu.device = Promise.resolve({});
    runtime.initFromDevice.mockRejectedValue(primary);
    await expect(
      createSharedDeviceSession({
        modelUrl: "/model.onnx",
        label: "mnist",
        isCancelled: () => false,
      })
    ).rejects.toBe(primary);
    expect(release).toHaveBeenCalledOnce();
  });

  it("releases a device adoption that finishes after cancellation", async () => {
    browser();
    const pending = deferred<unknown>();
    const release = vi.fn(async () => undefined);
    const dispose = vi.fn();
    const device = {};
    let cancelled = false;
    runtime.createSession.mockResolvedValue({
      inputNames: [],
      outputNames: [],
      release,
    });
    runtime.env.webgpu.device = Promise.resolve(device);
    runtime.initFromDevice.mockReturnValue(pending.promise);
    const creating = createSharedDeviceSession({
      modelUrl: "/model.onnx",
      label: "mnist",
      isCancelled: () => cancelled,
    });
    await vi.waitFor(() =>
      expect(runtime.initFromDevice).toHaveBeenCalledOnce()
    );
    cancelled = true;
    pending.resolve({ gpu: device, device: { gpu: device }, dispose });
    await expect(creating).rejects.toBeInstanceOf(OrtInitCancelled);
    expect(dispose).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

  it("releases both ownership layers once and preserves the first error", async () => {
    browser();
    const primary = new Error("gpu dispose failed");
    const sessionRelease = vi.fn(() => {
      throw new Error("session release failed");
    });
    const device = {};
    const dispose = vi.fn(() => {
      throw primary;
    });
    runtime.createSession.mockResolvedValue({
      inputNames: [],
      outputNames: [],
      release: sessionRelease,
    });
    runtime.env.webgpu.device = Promise.resolve(device);
    runtime.initFromDevice.mockResolvedValue({
      gpu: device,
      device: { gpu: device },
      dispose,
    });
    const shared = await createSharedDeviceSession({
      modelUrl: "/model.onnx",
      label: "mnist",
      isCancelled: () => false,
    });
    await expect(shared.release()).rejects.toBe(primary);
    await expect(shared.release()).rejects.toBe(primary);
    expect(dispose).toHaveBeenCalledOnce();
    expect(sessionRelease).toHaveBeenCalledOnce();
  });
});
