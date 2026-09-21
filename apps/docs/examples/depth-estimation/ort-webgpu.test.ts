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
  const dispose = vi.fn(() => {
    if (options.disposeError) throw options.disposeError;
  });
  const flush = vi.fn(async () => {
    if (options.flushError) throw options.flushError;
  });
  const raw = { size: 16 } as GPUBuffer;
  const gpu = {
    device: {
      wrapBuffer: vi.fn(() => ({
        gpu: options.identity === false ? {} : raw,
        dispose,
      })),
      queue: { flush },
    },
  } as unknown as Gpu;
  return { gpu, raw, dispose, flush };
}

describe("ORT GPU tensor ownership", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    runtime.env.webgpu.adapter = undefined;
    runtime.env.webgpu.device = undefined;
    runtime.env.wasm.numThreads = 0;
    runtime.env.wasm.wasmPaths = "";
  });
  afterEach(() => vi.unstubAllGlobals());

  it("validates type, dimensions, residency and byte size", () => {
    const raw = { size: 24 } as GPUBuffer;
    const tensor = { type: "float32", dims: [1, 6], gpuBuffer: raw };
    expect(assertGpuTensor(tensor as never, [1, 6], "depth")).toBe(raw);
    expect(() => assertGpuTensor(undefined, [1], "depth")).toThrow(
      "missing output"
    );
    expect(() =>
      assertGpuTensor({ ...tensor, type: "int32" } as never, [1, 6], "depth")
    ).toThrow("expected float32");
    expect(() =>
      assertGpuTensor({ ...tensor, dims: [6] } as never, [1, 6], "depth")
    ).toThrow("expected dimensions");
    expect(() =>
      assertGpuTensor(
        { ...tensor, gpuBuffer: { size: 4 } } as never,
        [1, 6],
        "depth"
      )
    ).toThrow("not GPU-resident");
  });

  it("flushes before releasing the non-owning wrapper", async () => {
    const { gpu, raw, flush, dispose } = fakeGpu();
    const consume = vi.fn(() => 42);
    await expect(withWrappedTensor(gpu, raw, consume)).resolves.toBe(42);
    expect(consume).toHaveBeenCalledOnce();
    expect(flush).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("flushes submitted work and preserves a consume failure over cleanup failures", async () => {
    const primary = new Error("draw failed");
    const { gpu, raw, flush, dispose } = fakeGpu({
      disposeError: new Error("dispose failed"),
    });
    await expect(
      withWrappedTensor(gpu, raw, () => {
        throw primary;
      })
    ).rejects.toBe(primary);
    expect(flush).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("releases the wrapper after flush or identity failures", async () => {
    const flushError = new Error("flush failed");
    const flushing = fakeGpu({ flushError });
    await expect(
      withWrappedTensor(flushing.gpu, flushing.raw, () => undefined)
    ).rejects.toBe(flushError);
    expect(flushing.dispose).toHaveBeenCalledOnce();

    const identity = fakeGpu({ identity: false });
    await expect(
      withWrappedTensor(identity.gpu, identity.raw, () => undefined)
    ).rejects.toThrow("lost GPUBuffer identity");
    expect(identity.flush).not.toHaveBeenCalled();
    expect(identity.dispose).toHaveBeenCalledOnce();
  });

  it("aborts a pending model fetch before session construction", async () => {
    const controller = new AbortController();
    vi.stubGlobal("navigator", {
      gpu: { requestAdapter: vi.fn(async () => ({})) },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, options: { signal?: AbortSignal }) =>
          new Promise<Response>((_resolve, reject) => {
            options.signal?.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError"))
            );
          })
      )
    );
    const creating = createSharedDeviceSession({
      modelUrl: "/model.onnx",
      label: "depth",
      signal: controller.signal,
      isCancelled: () => false,
    });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    controller.abort();
    await expect(creating).rejects.toBeInstanceOf(OrtInitCancelled);
    expect(runtime.createSession).not.toHaveBeenCalled();
  });

  it("releases a session that finishes after cancellation", async () => {
    const pending = deferred<unknown>();
    const release = vi.fn(async () => undefined);
    let cancelled = false;
    vi.stubGlobal("navigator", {
      gpu: { requestAdapter: vi.fn(async () => ({})) },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new Uint8Array([1, 2, 3])))
    );
    runtime.createSession.mockReturnValue(pending.promise);
    const creating = createSharedDeviceSession({
      modelUrl: "/model.onnx",
      label: "depth",
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

  it("rolls back the session when vgpu adoption fails with the same primary error", async () => {
    const primary = new Error("adoption failed");
    const release = vi.fn(async () => undefined);
    const device = {};
    vi.stubGlobal("navigator", {
      gpu: { requestAdapter: vi.fn(async () => ({})) },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new Uint8Array([1])))
    );
    runtime.createSession.mockResolvedValue({
      inputNames: [],
      outputNames: [],
      release,
    });
    runtime.env.webgpu.device = Promise.resolve(device);
    runtime.initFromDevice.mockRejectedValue(primary);
    await expect(
      createSharedDeviceSession({
        modelUrl: "/model.onnx",
        label: "depth",
        isCancelled: () => false,
      })
    ).rejects.toBe(primary);
    expect(release).toHaveBeenCalledOnce();
  });

  it("attempts both release layers once and preserves the first cleanup error", async () => {
    const primary = new Error("gpu dispose failed");
    const sessionRelease = vi.fn(async () => {
      throw new Error("session release failed");
    });
    const device = {};
    const dispose = vi.fn(() => {
      throw primary;
    });
    vi.stubGlobal("navigator", {
      gpu: { requestAdapter: vi.fn(async () => ({})) },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new Uint8Array([1])))
    );
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
      label: "depth",
      isCancelled: () => false,
    });
    await expect(shared.release()).rejects.toBe(primary);
    await expect(shared.release()).rejects.toBe(primary);
    expect(dispose).toHaveBeenCalledOnce();
    expect(sessionRelease).toHaveBeenCalledOnce();
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
