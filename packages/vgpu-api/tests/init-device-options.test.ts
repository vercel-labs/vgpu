import { afterEach, expect, test, vi } from "vitest";
import { createMockGPUDevice, Device, type CreateDeviceOptions, type VGPUAdapter } from "@vgpu/core";
import { init as initBrowser } from "../src/index.ts";
import { createMockAdapter, init } from "../src/mock.ts";

afterEach(() => vi.unstubAllGlobals());

test("explicit adapters receive required features and limits unchanged", async () => {
  const requestDevice = vi.fn(async (_opts?: CreateDeviceOptions) => new Device(createMockGPUDevice()));
  const adapter: VGPUAdapter = { requestDevice };
  const requiredFeatures = ["timestamp-query"] as const;
  const requiredLimits = { maxStorageBuffersInVertexStage: 2 };
  const gpu = await init({ adapter, requiredFeatures, requiredLimits });

  expect(requestDevice).toHaveBeenCalledOnce();
  expect(requestDevice.mock.calls[0]?.[0]).toMatchObject({ requiredFeatures, requiredLimits });
  expect(requestDevice.mock.calls[0]?.[0]?.requiredFeatures).toBe(requiredFeatures);
  expect(requestDevice.mock.calls[0]?.[0]?.requiredLimits).toBe(requiredLimits);
  gpu.dispose();
});

test("browser adapter receives required features and limits unchanged", async () => {
  const gpuDevice = createMockGPUDevice();
  const requestDevice = vi.fn(async () => gpuDevice);
  const requestAdapter = vi.fn(async () => ({ requestDevice, features: new Set(["timestamp-query"]), info: null } as unknown as GPUAdapter));
  vi.stubGlobal("navigator", { gpu: { requestAdapter } });
  const requiredFeatures = ["timestamp-query"] as const;
  const requiredLimits = { maxStorageBuffersInVertexStage: 3 };
  const gpu = await initBrowser({ requiredFeatures, requiredLimits });
  expect(requestDevice).toHaveBeenCalledWith({ requiredFeatures, requiredLimits });
  gpu.dispose();
});

test("browser init fails clearly when the adapter lacks a requested feature", async () => {
  const requestDevice = vi.fn(async () => createMockGPUDevice());
  const requestAdapter = vi.fn(async () => ({ requestDevice, features: new Set<string>(), info: null } as unknown as GPUAdapter));
  vi.stubGlobal("navigator", { gpu: { requestAdapter } });

  await expect(initBrowser({ requiredFeatures: ["depth-clip-control"] })).rejects.toMatchObject({
    code: "VGPU-FEATURE-UNSUPPORTED",
    message: expect.stringContaining('"depth-clip-control"'),
  });
  expect(requestDevice).not.toHaveBeenCalled();
});

test("mock adapter with declared features exposes requested features on device.features", async () => {
  const adapter = createMockAdapter({ features: ["depth-clip-control", "timestamp-query"] });
  const gpu = await init({ adapter, requiredFeatures: ["depth-clip-control"] });

  expect(gpu.device.features.has("depth-clip-control")).toBe(true);
  // Faithful to WebGPU: only requested features are enabled, not everything the adapter supports.
  expect(gpu.device.features.has("timestamp-query")).toBe(false);
  gpu.dispose();
});

test("mock init requesting an undeclared feature fails with VGPU-FEATURE-UNSUPPORTED", async () => {
  await expect(init({ requiredFeatures: ["depth-clip-control"] })).rejects.toMatchObject({
    code: "VGPU-FEATURE-UNSUPPORTED",
    message: expect.stringContaining('"depth-clip-control"'),
    fix: expect.stringContaining("requiredFeatures"),
  });
});

test("mock init without requiredFeatures keeps an empty device feature set", async () => {
  const gpu = await init({ adapter: createMockAdapter({ features: ["depth-clip-control"] }) });
  expect(gpu.device.features.has("depth-clip-control")).toBe(false);
  gpu.dispose();
});

test("omitted device capabilities remain omitted", async () => {
  const requestDevice = vi.fn(async (_opts?: CreateDeviceOptions) => new Device(createMockGPUDevice()));
  const gpu = await init({ adapter: { requestDevice } });
  expect(requestDevice.mock.calls[0]?.[0]?.requiredFeatures).toBeUndefined();
  expect(requestDevice.mock.calls[0]?.[0]?.requiredLimits).toBeUndefined();
  gpu.dispose();
});
